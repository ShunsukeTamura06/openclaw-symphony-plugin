# @openclaw/symphony

OpenClaw channel plugin for [Symphony](https://symphony.com/) Messaging.

Lets an OpenClaw on-prem deployment send and receive messages on Symphony using
the [Symphony REST API](https://rest-api.symphony.com/) and **Datafeed v5** for
inbound events. Authentication uses the standard **RSA-JWT bot
(service-account) flow** — no browser, no OAuth.

## Status

**v0.1.0 — initial cut.** Core paths covered: 1:1 IM and room/stream messaging,
attachments, mentions, emojis, Datafeed v5 long-poll. See
[Limitations](#limitations) for what is intentionally out of scope.

## Features

| Capability | Notes |
| --- | --- |
| Send to 1:1 IM | `client.createIm({ userIds })` then `sendMessage({ streamId, messageMl })` |
| Send to rooms / streams | Same `sendMessage` with the room's stream ID |
| Attachments | Multipart upload via `attachments: [{ filename, content, contentType }]` |
| Mentions | `<mention uid="…"/>` and `<mention email="…"/>` produced via `plainToMessageMl({ mentions })` |
| Emojis | `<emoji shortcode="…"/>` |
| Receive (Datafeed v5) | Long-poll loop, auto-recreates feed on 400/404 |
| Inbound → AI dispatch | Wired via `openclaw/plugin-sdk/inbound-reply-dispatch` (`runInboundReplyTurn`); resolves agent route, records session, dispatches to OpenClaw's AI reply pipeline, delivers reply back to Symphony |
| Token auth | RS512 JWT → sessionToken + keyManagerToken; transparent refresh on 401 |

## Install

This plugin targets OpenClaw `>=2026.5.6`. Install it into your OpenClaw
deployment as you would any other channel plugin:

```bash
pnpm add @openclaw/symphony
# or, with the OpenClaw CLI
openclaw plugin install @openclaw/symphony
```

> **Note:** the package is currently consumable directly from this repository.
> Publishing to npm is not part of v0.1.0.

## Configuration

Configure under `channels.symphony` in your OpenClaw config (single account):

```yaml
channels:
  symphony:
    podUrl: https://acme.symphony.com
    agentUrl: https://acme-agent.symphony.com
    relayUrl: https://acme.symphony.com   # optional; defaults to podUrl
    username: openclaw-bot
    privateKeyPath: /etc/openclaw/secrets/symphony-bot.pem
    enabled: true
```

### Access control (optional)

Both filters run **before the LLM is invoked**, so blocked messages never
hit the agent runtime.

```yaml
channels:
  symphony:
    # ...
    allowedUsers:
      - "86311662783854"           # by Symphony userId (digits only)
      - "alice@example.com"        # by email (contains '@')
      - "bob.smith"                # by username (anything else)
    allowedRooms:
      - "vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA"   # streamId of an allowed room
      - "abcDEF123_-=="                         # another room
```

> **Tip:** Either base64 form of the streamId works in `allowedRooms`.
> The Symphony web client's "Copy ID" gives you standard base64
> (`vTOlxOhTcjFCKZ8GHrSlhX///oRm1dlFdA==`), while Datafeed delivers the
> URL-safe form (`vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA`). The matcher
> canonicalizes both sides, so you can paste whatever the client gave
> you without translation.

- `allowedUsers`: if set, only matching senders can interact with the
  bot. Each entry matches by *userId* (digits-only), *email* (contains
  `@`), or *username* (anything else). Applies to both DMs and rooms.
- `allowedRooms`: if set, only listed `streamId`s (group conversations)
  are processed. **DMs/1:1 IMs are NOT gated by this list** — DMs are
  governed by `allowedUsers` + `denyDmsByDefault` instead.
- `denyDmsByDefault` (default **`true`**, since v0.2): DMs are gated by
  `allowedUsers`:
    - if `allowedUsers` is set, only listed senders can DM the bot
    - if `allowedUsers` is unset/empty, **ALL DMs are blocked**
  Set `denyDmsByDefault: false` to restore the permissive legacy
  behavior where any user could DM the bot when `allowedUsers` was unset.
- When `allowedUsers` and `allowedRooms` are both set, room messages
  must pass **both** filters (AND).
- Omitting `allowedUsers` and `allowedRooms` means "allow everything in
  rooms"; DMs are still blocked by `denyDmsByDefault` unless you opt out.

> ⚠️ **Upgrade note (v0.1.x → v0.2)**: the default DM policy now denies
> DMs from anyone not in `allowedUsers`. If your previous setup relied
> on open DMs (no `allowedUsers` configured), either:
> 1. populate `allowedUsers` with the people allowed to DM the bot, or
> 2. set `denyDmsByDefault: false` to keep the old behavior.

Or with multiple accounts:

```yaml
channels:
  symphony:
    defaultAccount: prod
    accounts:
      prod:
        podUrl: https://acme.symphony.com
        agentUrl: https://acme-agent.symphony.com
        username: openclaw-bot
        privateKeyPath: /etc/openclaw/secrets/symphony-bot.pem
      qa:
        podUrl: https://qa.symphony.com
        agentUrl: https://qa-agent.symphony.com
        username: openclaw-qa-bot
        privateKeyPath: /etc/openclaw/secrets/qa-bot.pem
```

### Required Symphony admin steps (one-time)

1. In the Symphony **Admin Portal**, create a **service account** for the bot
   and capture the `username`.
2. Generate an RSA key pair (recommended: 4096-bit, PKCS#8):
   ```bash
   openssl genpkey -algorithm RSA -out symphony-bot.pem -pkeyopt rsa_keygen_bits:4096
   openssl rsa -in symphony-bot.pem -pubout -out symphony-bot.pub
   ```
3. Upload the **public** key to the service account's profile in the Admin
   Portal. Keep the **private** key on the OpenClaw host and reference it via
   `privateKeyPath`.
4. Make sure the bot has any required permissions (e.g. "Create IM", "Send
   Message to Stream") for the streams you want it to use.

## Local smoke tests

You can sanity-check the plugin without an OpenClaw host by talking directly to
your Symphony pod with the included scripts:

```bash
cp .env.example .env
# edit .env with real values
pnpm install
pnpm smoke:send "hello from openclaw"
pnpm smoke:datafeed   # listens for 30s, prints incoming messages
```

## Programmatic use

The Symphony client is exported separately and can be used standalone:

```ts
import { SymphonyClient, plainToMessageMl } from "@openclaw/symphony/api";
import { readFileSync } from "node:fs";

const client = new SymphonyClient({
  env: {
    podUrl: "https://acme.symphony.com",
    agentUrl: "https://acme-agent.symphony.com",
  },
  credentials: {
    username: "openclaw-bot",
    privateKeyPem: readFileSync("./symphony-bot.pem", "utf8"),
  },
});

await client.sendMessage({
  streamId: "<stream-id>",
  messageMl: plainToMessageMl({
    text: "Hello",
    mentions: [{ kind: "email", email: "alice@example.com" }],
    emojis: ["wave"],
  }),
});
```

## Architecture

```
index.ts                              defineChannelPluginEntry
├── src/plugin.ts                     createChatChannelPlugin (id, meta, adapters)
├── src/setup.ts                      setup adapter + setup wizard
├── src/outbound.ts                   outbound + message adapter (target parse/format, send)
├── src/gateway.ts                    gateway adapter (datafeed loop owner)
├── src/status.ts                     status adapter (sessioninfo probe)
├── src/config.ts / config-schema.ts  account resolution + zod schema
├── src/messageml.ts                  MessageML <-> plain text converters
├── src/normalize.ts                  Symphony events -> OpenClaw inbound shape
├── src/runtime.ts                    runtime singleton + client cache
└── src/symphony/                     OpenClaw-independent Symphony API library
    ├── auth.ts                       RS512 JWT, dual-token authenticate
    ├── http.ts                       fetch wrapper (auth headers, retry, refresh)
    ├── client.ts                     SymphonyClient class
    ├── messages.ts                   send/get message + attachment endpoints
    ├── streams.ts                    IM/room creation, stream info
    ├── users.ts                      user lookup, sessioninfo
    ├── datafeed.ts                   v5 datafeed CRUD endpoints
    ├── datafeed-loop.ts              long-poll loop with recovery
    └── types.ts                      Symphony API types
```

## Limitations (v0.1.0)

- **No streaming token-delta replies.** OpenClaw's preview/block streaming
  protocol is honored at the outbound layer (one final message per send), as is
  conventional for chat platforms without typing-level token streams.
- **No room creation UI** — rooms must already exist; the plugin can post to a
  stream/room ID you supply.
- **Pairing / DM allowlist policy** is wired up but not exhaustively tested —
  uses the SDK's standard `createPairingPrefixStripper` and `chatTypes`.
- **Element forms / actions** (Symphony interactive elements with
  `SYMPHONY_ELEMENTS_ACTION` events) are **not** parsed yet. The datafeed loop
  receives them and discards them.

## Testing

```bash
pnpm install
pnpm test          # unit tests for client / auth / messageml / datafeed loop
pnpm typecheck     # TypeScript check
```

The test suite uses fake `fetch` implementations and does not require Symphony
network access. **End-to-end testing against a real Symphony pod is manual**
via the smoke scripts above (Symphony does not offer a free public sandbox).

## License

MIT — see [LICENSE](./LICENSE).
