# Symphony Channel — Setup Guide

This guide walks through the one-time configuration to make the OpenClaw
Symphony channel plugin work against your Symphony pod.

## 1. Create a Symphony service account

1. Sign in to the **Symphony Admin Portal** with an administrator account.
2. Go to **People & Compliance → Service Accounts → New**.
3. Set the bot's username (e.g. `openclaw-bot`). This will be the value of
   `channels.symphony.username`.
4. Set the account type to **Bot**. Note the **email address** Symphony
   assigns — useful when other users mention the bot from clients.

## 2. Generate an RSA key pair

```bash
# 4096-bit RSA, PKCS#8 PEM (the format Node's crypto APIs expect)
openssl genpkey -algorithm RSA \
  -out symphony-bot.pem \
  -pkeyopt rsa_keygen_bits:4096

# Extract the public key
openssl rsa -in symphony-bot.pem -pubout -out symphony-bot.pub
```

Store `symphony-bot.pem` somewhere only the OpenClaw process can read
(e.g. `/etc/openclaw/secrets/symphony-bot.pem`, mode `0600`).

## 3. Upload the public key

In the Admin Portal:

1. Open the service account you created.
2. Edit **Public Keys → Add Public Key** and paste the contents of
   `symphony-bot.pub` (the `-----BEGIN PUBLIC KEY-----` PEM).
3. Save. Symphony begins accepting JWTs signed with the matching private key.

## 4. Find your pod and agent URLs

| Field | Where to find it |
| --- | --- |
| `podUrl` | The web URL you use to access Symphony (e.g. `https://acme.symphony.com`). Visit `/agent/v3/info` or `/pod/v1/podcert` to verify. |
| `agentUrl` | The agent service URL (e.g. `https://acme-agent.symphony.com`). Often a different DNS name from the pod. Ask your Symphony admin if unsure. |
| `relayUrl` *(optional)* | Some Symphony deployments use a separate relay host for the key manager pubkey endpoint. Leave blank to reuse `podUrl`. |

## 5. Configure OpenClaw

Add the channel block to your OpenClaw config:

```yaml
channels:
  symphony:
    podUrl: https://acme.symphony.com
    agentUrl: https://acme-agent.symphony.com
    username: openclaw-bot
    privateKeyPath: /etc/openclaw/secrets/symphony-bot.pem
    enabled: true
```

Restart the OpenClaw process or reload the channel. Run `openclaw doctor` to
verify the plugin is loaded and the account looks healthy.

## 6. Verify

The fastest verification is the included smoke script:

```bash
# In the plugin's checkout
cp .env.example .env
$EDITOR .env       # fill in real values + a stream ID you can post to
pnpm install
pnpm smoke:send "hello"
pnpm smoke:datafeed
```

If both scripts succeed, the bot is properly authenticated and reachable.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401 Unauthorized` on `/login/pubkey/authenticate` | JWT clock skew, wrong username, or public key not yet propagated. JWTs expire fast (default 290s). |
| `403 Forbidden` on `sendMessage` | Bot is not a member of the target stream/room, or lacks "Send Message" entitlement. |
| `400 Bad Request` from Datafeed `read` | Stale feed ID — the loop will recreate it automatically. |
| Bot does not see DM messages from a user | The user has not connected with the bot yet. In the Symphony client, search for the bot and click "Connect"; many pods auto-accept connection requests for service accounts. |
| `Symphony pubkey authenticate failed` to `/relay/pubkey/...` | Your deployment uses a separate KM/relay host. Set `relayUrl` explicitly. |
