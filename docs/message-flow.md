# Symphony Message Flow

End-to-end flow when a user sends a message in Symphony and gets a reply back
from the OpenClaw AI.

## 1. Sequence: a single inbound → reply turn

```mermaid
sequenceDiagram
    autonumber
    participant U as Symphony user
    participant SP as Symphony pod
    participant DL as Datafeed loop<br/>(src/symphony/datafeed-loop.ts)
    participant GW as gateway.ts<br/>handleInboundEnvelope
    participant Q as InboundQueue<br/>(per-stream serial)
    participant DI as gateway.ts<br/>dispatchInboundToAi
    participant SDK as OpenClaw SDK<br/>runInboundReplyTurn
    participant AI as Agent (LLM)
    participant OUT as outbound.ts<br/>sendSymphonyMessage

    U->>SP: post message to stream
    Note over DL,SP: Long-poll<br/>POST /agent/v5/datafeeds/{id}/read
    SP-->>DL: MESSAGESENT envelope
    DL->>GW: onEvent(envelope)

    GW->>GW: extractMessageFromEvent<br/>+ normalizeInboundMessage
    Note over GW: drop if sender == selfUserId
    GW->>GW: allowedUsers gate
    Note over GW: drop if group<br/>and bot not @mentioned
    GW->>GW: dedupe<br/>(accountId:streamId:messageId)
    GW->>Q: enqueue(job)
    GW-->>DL: return (does NOT wait)
    DL->>SP: next long-poll

    Q->>DI: run job (serial per stream)
    DI->>SDK: resolveAgentRoute<br/>+ finalizeInboundContext
    SDK->>SDK: recordInboundSession<br/>+ updateLastRoute
    SDK->>AI: run agent turn
    AI-->>SDK: streamed reply blocks
    loop one or more blocks
        SDK->>DI: delivery.deliver(payload, info)
        DI->>DI: textWithSymphonyFormToMessageMl<br/>(Markdown → MessageML)
        DI->>OUT: sendSymphonyMessage(messageMl)
        alt MessageML accepted
            OUT->>SP: POST /agent/v4/stream/{id}/message/create
            SP-->>OUT: { messageId, timestamp }
            DI->>DI: dedupeStore.mark(sentMessageId)
        else MessageML rejected (A — plain-text fallback)
            OUT-->>DI: throw
            DI->>DI: stripToPlainMessageMl(text)
            DI->>OUT: sendSymphonyMessage(plainMl)
            OUT->>SP: POST /agent/v4/stream/{id}/message/create
            SP-->>OUT: { messageId, timestamp }
        end
    end
    SP-->>U: see the reply in Symphony

    Note over DI: finally
    alt deliverySent === 0 AND any send error happened
        DI->>OUT: sendSymphonyMessage(APOLOGY_MESSAGE)<br/>(B — soft apology)
        OUT->>SP: POST .../message/create
        SP-->>U: 「返信をうまくお届けできなかったみたいです…」
    end
    Note over DI: if deliverySent === 0,<br/>emit "Symphony NO-DELIVERY" warning to logs
```

## 2. Inbound filter pipeline (decision tree)

```mermaid
flowchart TD
    Start([Datafeed envelope]) --> T{type?}
    T -->|MESSAGESENT| EX[extractMessageFromEvent]
    T -->|SYMPHONYELEMENTSACTION| EL[normalizeElementsAction<br/>form submission]
    T -->|other| DROP1([drop])

    EX --> N[normalizeInboundMessage<br/>MessageML → text<br/>+ extract mentions/attachments]
    N --> SELF{sender == self?}
    SELF -->|yes| DROP2([drop — own echo])
    SELF -->|no| ALLOW

    EL --> ALLOW

    ALLOW{allowedUsers<br/>configured?}
    ALLOW -->|no| MENT
    ALLOW -->|yes, match| MENT
    ALLOW -->|yes, no match| DROP3([drop — not in allowlist])

    MENT{group room<br/>and not Elements?}
    MENT -->|no — DM or Elements| DEDUP
    MENT -->|yes| MM{bot @mentioned?}
    MM -->|yes| DEDUP
    MM -->|no| DROP4([drop — not addressed])

    DEDUP{messageId<br/>seen before?}
    DEDUP -->|yes| DROP5([drop — duplicate])
    DEDUP -->|no, mark new| ENQ[InboundQueue.enqueue]

    ENQ --> DONE([return — async dispatch])
```

## 3. Module layout

```mermaid
flowchart LR
    subgraph external [External systems]
        SP[Symphony pod<br/>REST + Datafeed v5]
        HOST[OpenClaw host<br/>channelRuntime: routing/session/reply]
    end

    subgraph plugin [openclaw-symphony-plugin]
        subgraph entry [Entry / wiring]
            IDX[index.ts<br/>defineChannelPluginEntry]
            PLG[src/plugin.ts<br/>createChatChannelPlugin]
        end

        subgraph adapters [Adapters]
            GW[src/gateway.ts<br/>start/stop + inbound dispatch]
            OUT[src/outbound.ts<br/>send to Symphony]
            SET[src/setup.ts<br/>applyAccountConfig]
            ST[src/status.ts<br/>probeAccount]
        end

        subgraph plumbing [Plumbing]
            DED[src/dedupe.ts]
            QU[src/inbound-queue.ts]
            NRM[src/normalize.ts<br/>events → NormalizedInboundMessage]
            MML[src/messageml.ts<br/>+ markdown-to-messageml.ts]
            CFG[src/config.ts<br/>+ config-schema.ts]
            RT[src/runtime.ts<br/>SymphonyClient cache]
        end

        subgraph sym [Symphony API library]
            CLI[src/symphony/client.ts]
            AUT[auth.ts RSA-JWT]
            HTTP[http.ts fetch wrapper]
            DF[datafeed.ts +<br/>datafeed-loop.ts]
            MSG[messages.ts]
            STR[streams.ts]
            USR[users.ts]
        end
    end

    IDX --> PLG
    PLG --> GW & OUT & SET & ST
    GW -->|inbound| NRM
    GW -->|inbound| DED
    GW -->|inbound| QU
    GW -->|outbound via delivery.deliver| OUT
    OUT --> MML
    OUT --> RT
    RT --> CLI
    GW --> RT
    GW --> DF
    DF --> CLI
    CLI --> AUT
    CLI --> HTTP
    CLI --> MSG
    CLI --> STR
    CLI --> USR
    HTTP -.HTTPS.-> SP
    AUT -.HTTPS.-> SP
    GW <-->|channelRuntime| HOST
```

## 4. Lifecycle: account start / stop

```mermaid
stateDiagram-v2
    [*] --> Unconfigured
    Unconfigured --> Configured: applyAccountConfig writes channels.symphony.accounts.<id>
    Configured --> Starting: OpenClaw calls gateway.startAccount
    Starting --> Authenticating: getOrCreateClient
    Authenticating --> Running: sessionInfo OK<br/>setStatus { running: true }
    Authenticating --> Failed: setStatus { lastError }
    Running --> Polling: runDatafeedLoop
    Polling --> Polling: read → onEvent → next read
    Polling --> Recreating: 400/404 on read
    Recreating --> Polling: createDatafeed
    Running --> Stopping: abortSignal
    Stopping --> Drained: inboundQueue.drain()
    Drained --> Disposed: disposeClient<br/>setStatus { running: false }
    Disposed --> [*]
    Failed --> [*]
```

## 5. Reply resilience (A + B)

What the Symphony user sees when something goes wrong with the reply:

```mermaid
flowchart TD
    Recv[Inbound message accepted] --> Run[AI run produces reply text]
    Run --> Send1["sendSymphonyMessage<br/>(MessageML from Markdown)"]
    Send1 -->|200 OK| OK[reply visible<br/>deliverySent++ ✅]
    Send1 -->|reject| StripA["A: stripToPlainMessageMl<br/>(escape + br only)"]
    StripA --> Send2["sendSymphonyMessage<br/>(plain MessageML)"]
    Send2 -->|200 OK| OK2[reply visible<br/>format lost, content delivered ✅]
    Send2 -->|reject| Apol["B: send APOLOGY_MESSAGE<br/>「返信をうまくお届けできなかった<br/>みたいです…」"]
    Apol -->|200 OK| Apol2[apology visible<br/>user knows turn ended ⚠]
    Apol -->|reject| LogOnly[log-only — nothing reaches Symphony 🚨]
```

| Layer | Trigger | What the user sees |
| --- | --- | --- |
| **Happy path** | MessageML accepted | Formatted reply |
| **A — plain-text fallback** | MessageML rejected (malformed XML) | Unformatted reply with the same words |
| **B — apology** | even plain-text rejected, or dispatcher dropped a payload | Fixed apology message in JP |
| **B falls through** | even the apology failed | Nothing on Symphony, logs warn `Symphony NO-DELIVERY` |

### Why there is no "C — processing indicator"

An earlier iteration added a `⏳ hourglass` emoji reaction on inbound and
removed it on completion, to give the Symphony user a visible "OpenClaw
saw this" signal while the AI was thinking. **That feature was removed**
because Symphony's *public REST API* does not expose any reaction
add/remove endpoint:

- The official FINOS [symphony-api-spec](https://github.com/finos/symphony-api-spec)
  has zero matches for `reaction` across both the pod and agent OpenAPI
  specs.
- The user-facing emoji reactions feature in the Symphony web client is
  *not* callable from bots.
- No official Symphony BDK (Java / Python / .NET) ships a reactions
  client method.

If your Symphony deployment exposes a private reactions endpoint, this
plugin does *not* use it — wire it up at the application layer if you
need it. See the comment block at the top of `src/gateway.ts` for the
historical context before re-adding any reaction code.

## Key invariants

| Invariant | Where enforced |
| --- | --- |
| Self-messages do not trigger a reply | `normalizeInboundMessage` `selfUserId` check + `dedupeStore.mark(sentId)` after send |
| No duplicate processing of the same `messageId` | `MessageDedupeStore.markIfNew` |
| Same conversation processes in order | `InboundQueue` (per `(accountId, streamId)` serial) |
| Group rooms require bot @mention (except form submissions) | mention gate in `handleInboundEnvelope` |
| Silent reply failures are observable | `Symphony NO-DELIVERY` warn in `dispatchInboundToAi` finally |
| Graceful shutdown does not cut replies mid-stream | `inboundQueue.drain()` in `stopAccount` |
| MessageML conversion failure does not lose the reply text | plain-text fallback in `delivery.deliver` (A) |
| If even the fallback fails, the user gets a clear "we failed" signal | apology message in `dispatchInboundToAi` finally (B) |
