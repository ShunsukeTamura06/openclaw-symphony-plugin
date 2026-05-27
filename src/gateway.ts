import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelGatewayContext,
  ChannelLogSink,
} from "openclaw/plugin-sdk/channel-contract";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { buildSymphonyDedupeKey, MessageDedupeStore } from "./dedupe.js";
import { InboundQueue } from "./inbound-queue.js";
import { sendSymphonyMessage } from "./outbound.js";
import {
  extractMessageFromEvent,
  normalizeElementsAction,
  normalizeInboundMessage,
  type NormalizedInboundMessage,
} from "./normalize.js";
import { stripToPlainMessageMl, textWithSymphonyFormToMessageMl } from "./messageml.js";
import { disposeClient, getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
import { runDatafeedLoop } from "./symphony/datafeed-loop.js";
import { CHANNEL_ID, type ResolvedSymphonyAccount } from "./types.js";

/**
 * Soft apology surfaced to the Symphony user when the AI run finished
 * but no reply made it to Symphony (MessageML send failed even after the
 * plain-text fallback). Wording matches OpenClaw's overall tone: friendly,
 * non-alarming, and points to where the actual reply can still be seen.
 */
const APOLOGY_MESSAGE =
  "<messageML>返信をうまくお届けできなかったみたいです…。OpenClaw の管理画面から内容をご確認ください。</messageML>";

// NOTE: Earlier iterations included a "hourglass" emoji reaction lifecycle
// (added on inbound, removed on completion) to signal "OpenClaw is
// processing your message" back to Symphony. That feature was removed
// because Symphony's *public REST API* — verified against the FINOS
// canonical OpenAPI specs at github.com/finos/symphony-api-spec — does
// not expose any reaction add/remove endpoint. The user-facing reactions
// feature in the Symphony web client is not callable from bots. Do not
// re-add reaction API calls without first confirming a documented
// endpoint exists in your deployment's Symphony version.

type RunInboundReplyTurnParams = Parameters<typeof runInboundReplyTurn<NormalizedInboundMessage>>[0];
type ChannelTurnAdapter = RunInboundReplyTurnParams["adapter"];
type ResolvedChannelTurn = ReturnType<ChannelTurnAdapter["resolveTurn"]> extends Promise<infer T>
  ? T
  : ReturnType<ChannelTurnAdapter["resolveTurn"]>;

type AgentRoute = {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  lastRoutePolicy: "main" | "session";
};

type FullChannelRuntime = {
  routing: {
    resolveAgentRoute: (input: {
      cfg: OpenClawConfig;
      channel: string;
      accountId?: string | null;
      peer?: { kind: "direct" | "group"; id: string } | null;
    }) => AgentRoute;
  };
  session: {
    resolveStorePath: (store: string | undefined, opts?: { agentId?: string }) => string;
    recordInboundSession: ResolvedChannelTurn extends { recordInboundSession: infer R } ? R : never;
  };
  reply: {
    finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ResolvedChannelTurn extends { ctxPayload: infer C } ? C : never;
    dispatchReplyWithBufferedBlockDispatcher: ResolvedChannelTurn extends {
      dispatchReplyWithBufferedBlockDispatcher: infer D;
    }
      ? D
      : never;
  };
};

export type SymphonyGatewayContext = ChannelGatewayContext<ResolvedSymphonyAccount>;

// Module-level singletons. The queue + dedupe live for the lifetime of the
// host process; both `accountId` and `streamId` are part of the keys so
// multiple accounts coexist safely without cross-talk.
const inboundQueue = new InboundQueue({
  onError: (err, job) =>
    getSymphonyRuntime().error(
      `inbound job ${job.accountId}/${job.streamId}/${job.messageId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ),
});
const dedupeStore = new MessageDedupeStore();

export const symphonyGatewayAdapter = {
  async startAccount(ctx: SymphonyGatewayContext): Promise<void> {
    const log = adoptLog(ctx.log);

    if (!ctx.account.privateKeyPath) {
      ctx.setStatus({
        accountId: ctx.accountId,
        running: false,
        lastError: "privateKeyPath is required",
      });
      return;
    }

    ctx.setStatus({
      accountId: ctx.accountId,
      running: true,
      lastStartAt: Date.now(),
      lastError: null,
    });

    log.info(`Starting Symphony datafeed for ${ctx.account.username}`);
    const client = getOrCreateClient(ctx.accountId, ctx.account);

    let selfUserId: number | undefined;
    try {
      const session = await client.sessionInfo();
      selfUserId = session.id;
      log.info(`Authenticated as ${session.displayName ?? session.username ?? session.id}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Symphony authentication failed: ${msg}`);
      ctx.setStatus({ accountId: ctx.accountId, running: false, lastError: msg });
      return;
    }

    const channelRuntime = ctx.channelRuntime as unknown as FullChannelRuntime | undefined;
    if (!channelRuntime?.routing || !channelRuntime.session || !channelRuntime.reply) {
      log.warn(
        "channelRuntime not available — Symphony will receive events but cannot dispatch to AI",
      );
    }

    const tag = ctx.account.datafeedTag ?? `openclaw-${ctx.accountId}`;

    await runDatafeedLoop({
      client,
      tag,
      signal: ctx.abortSignal,
      handlers: {
        onLog: (m) => log.info(m),
        onError: (e) => log.error(e instanceof Error ? e.message : String(e)),
        onEvent: (envelope) =>
          handleInboundEnvelope({
            envelope,
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            ...(selfUserId !== undefined ? { selfUserId } : {}),
            ...(ctx.account.allowedUsers ? { allowedUsers: ctx.account.allowedUsers } : {}),
            channelRuntime,
            log,
            queue: inboundQueue,
            dedupe: dedupeStore,
          }),
      },
    });
  },

  async stopAccount(ctx: SymphonyGatewayContext): Promise<void> {
    const log = adoptLog(ctx.log);
    // The Datafeed read loop is owned by `startAccount` and stops on its own
    // when OpenClaw aborts ctx.abortSignal. We additionally:
    //   1. drain in-flight inbound jobs so we don't leave AI replies mid-stream
    //   2. dispose the cached HTTP client so tokens/keys don't sit in memory
    try {
      await inboundQueue.drain();
    } catch (err) {
      log.warn(`inbound queue drain reported: ${err instanceof Error ? err.message : String(err)}`);
    }
    disposeClient(ctx.accountId, ctx.account);
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
    log.info(`Stopped Symphony datafeed for ${ctx.account.username}`);
  },
};

/**
 * Pure-ish helper that processes one Datafeed envelope:
 *   1. extract MESSAGESENT payload (drop other event kinds)
 *   2. normalize + filter self-message
 *   3. dedupe by `accountId:streamId:messageId`
 *   4. enqueue the AI dispatch on the per-stream serial queue
 *
 * Returns synchronously — does NOT wait for AI dispatch.
 * Exported so unit tests can exercise it without spinning up a datafeed loop.
 */
export function handleInboundEnvelope(params: {
  envelope: Parameters<NonNullable<Parameters<typeof runDatafeedLoop>[0]["handlers"]["onEvent"]>>[0];
  cfg: OpenClawConfig;
  accountId: string;
  selfUserId?: number;
  allowedUsers?: string[];
  channelRuntime: FullChannelRuntime | undefined;
  log: ChannelLogSink;
  queue: InboundQueue;
  dedupe: MessageDedupeStore;
}): void {
  const message = extractMessageFromEvent(params.envelope);
  const isElementsAction = !message && params.envelope.type === "SYMPHONYELEMENTSACTION";

  let normalized: NormalizedInboundMessage | null = null;
  if (message) {
    normalized = normalizeInboundMessage({
      message,
      accountId: params.accountId,
      ...(params.selfUserId !== undefined ? { selfUserId: params.selfUserId } : {}),
    });
  } else if (isElementsAction) {
    normalized = normalizeElementsAction({
      envelope: params.envelope,
      accountId: params.accountId,
      ...(params.selfUserId !== undefined ? { selfUserId: params.selfUserId } : {}),
    });
  }
  if (!normalized) {
    return;
  }
  if (params.allowedUsers && params.allowedUsers.length > 0) {
    if (!isSenderAllowed(normalized.sender, params.allowedUsers)) {
      params.log.info(
        `Symphony message ignored: sender ${normalized.sender.id} not in allowedUsers`,
      );
      return;
    }
  }
  // @mention required in group rooms for regular messages, but not for form submissions
  if (!isElementsAction && !normalized.isDirect && params.selfUserId !== undefined) {
    const isMentioned = normalized.mentions.some((m) => m.userId === params.selfUserId);
    if (!isMentioned) {
      return;
    }
  }
  const dedupeKey = buildSymphonyDedupeKey({
    accountId: params.accountId,
    streamId: normalized.streamId,
    messageId: normalized.messageId,
  });
  if (!params.dedupe.markIfNew(dedupeKey)) {
    params.log.info(`duplicate Symphony message skipped: ${dedupeKey}`);
    return;
  }
  params.queue.enqueue({
    accountId: params.accountId,
    streamId: normalized.streamId,
    messageId: normalized.messageId,
    run: async () => {
      await dispatchInboundToAi({
        cfg: params.cfg,
        accountId: params.accountId,
        normalized,
        channelRuntime: params.channelRuntime,
        log: params.log,
      });
    },
  });
}

async function dispatchInboundToAi(params: {
  cfg: OpenClawConfig;
  accountId: string;
  normalized: NormalizedInboundMessage;
  channelRuntime: FullChannelRuntime | undefined;
  log: ChannelLogSink;
}): Promise<void> {
  const { cfg, accountId, normalized, channelRuntime, log } = params;

  if (!channelRuntime?.routing || !channelRuntime.session || !channelRuntime.reply) {
    return;
  }

  const peerKind = normalized.isDirect ? ("direct" as const) : ("group" as const);
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: peerKind, id: normalized.streamId },
  });

  const storePath = channelRuntime.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  const senderLabel =
    normalized.sender.displayName ?? normalized.sender.email ?? normalized.sender.id;
  const baseCtx = {
    Body: normalized.text,
    BodyForAgent: normalized.text,
    BodyForCommands: normalized.text,
    From: normalized.sender.email ?? normalized.sender.id,
    To: normalized.streamId,
    SessionKey: route.sessionKey,
    MessageSid: normalized.messageId,
    ChatType: peerKind,
    ConversationLabel: senderLabel,
    // Refs Q2 (docs/review-2026-05-20.md):
    // Sender identity fields. Without these the AI prompt referred to the
    // speaker only via ConversationLabel, which is fragile in multi-user
    // rooms — different users with the same displayName or unset display
    // names would collide. SenderId is a stable identifier the agent can
    // use to disambiguate.
    SenderName: normalized.sender.displayName,
    SenderId: normalized.sender.id,
    SenderUsername: normalized.sender.username,
    CommandAuthorized: false,
  };
  const ctxPayload = channelRuntime.reply.finalizeInboundContext(baseCtx);
  const trace = newTurnTrace(normalized.messageId);

  try {
    await runInboundReplyTurn<NormalizedInboundMessage>({
      channel: CHANNEL_ID,
      accountId,
      raw: normalized,
      adapter: {
        ingest: () => ({
          id: normalized.messageId,
          timestamp: normalized.timestamp,
          rawText: normalized.text,
          textForAgent: normalized.text,
          textForCommands: normalized.text,
          raw: normalized,
        }),
        resolveTurn: () => ({
          cfg,
          channel: CHANNEL_ID,
          accountId,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          // Refs Q1 (docs/review-2026-05-20.md):
          // updateLastRoute keeps the session's lastChannel/to metadata in
          // sync with the channel that last delivered an inbound. The
          // current-turn reply works without this because delivery.deliver
          // calls sendSymphonyMessage inline, but the session metadata is
          // what other channels / CLI / management UI consult when they
          // later try to continue the conversation. Cost is one record
          // write per inbound; benefit is correct cross-channel routing.
          record: {
            updateLastRoute: {
              sessionKey: route.sessionKey,
              channel: CHANNEL_ID,
              to: normalized.streamId,
              accountId,
            },
            onRecordError: (err: unknown) => {
              log.warn?.(
                `Failed updating Symphony session meta: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          },
          delivery: {
            deliver: async (payload: ReplyPayload, info: { kind: string }) => {
              const text = payload.text ?? "";
              const kind = info.kind ?? "unknown";
              recordInvocation(trace, kind);
              log.info(
                `Symphony deliver turn=${trace.turnId} kind=${kind} textLen=${text.length} hasMedia=${Boolean(payload.mediaUrl)}`,
              );
              if (!text && !payload.mediaUrl) {
                trace.emptyPayloadsSkipped += 1;
                log.info(
                  `Symphony deliver turn=${trace.turnId} kind=${kind} -> skipped (empty payload)`,
                );
                return;
              }
              const messageMl = textWithSymphonyFormToMessageMl(text);
              try {
                await sendAndMarkEcho({
                  cfg,
                  accountId,
                  streamId: normalized.streamId,
                  messageMl,
                  trace,
                  kind,
                  log,
                });
              } catch (sendErr) {
                // (A) Plain-text fallback. The most common cause of a
                // sendMessage failure here is that the rich Markdown →
                // MessageML conversion produced XML that Symphony rejected
                // (unclosed tag, weird entity, etc.). Retry once with the
                // text stripped of all markup so the user at least gets
                // the words — formatting is the sacrifice.
                trace.sendErrors += 1;
                log.warn?.(
                  `Symphony reply send failed turn=${trace.turnId} kind=${kind}, retrying as plain text: ${
                    sendErr instanceof Error ? sendErr.message : String(sendErr)
                  }`,
                );
                try {
                  await sendAndMarkEcho({
                    cfg,
                    accountId,
                    streamId: normalized.streamId,
                    messageMl: stripToPlainMessageMl(text),
                    trace,
                    kind: `${kind}+plaintext`,
                    log,
                  });
                } catch (fallbackErr) {
                  trace.sendErrors += 1;
                  log.error(
                    `Symphony reply send FAILED (after plain-text fallback) turn=${trace.turnId} kind=${kind}: ${
                      fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
                    }`,
                  );
                  throw fallbackErr;
                }
              }
            },
            onError: (err: unknown, info: { kind: string }) => {
              trace.deliveryErrors += 1;
              log.error(
                `Symphony deliver onError turn=${trace.turnId} kind=${info.kind}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            },
          },
          // Observability for the long-thinking GUI-only bug. The reply
          // pipeline can silently SKIP a delivery (silentReplyContext,
          // duplicate suppression, internal timeouts, etc.) and we'd never
          // know. Hook into the dispatcher's skip path to attribute it.
          dispatcherOptions: {
            onSkip: (
              payload: ReplyPayload,
              info: { kind: string; reason?: string },
            ) => {
              trace.dispatcherSkipped += 1;
              log.warn?.(
                `Symphony dispatch skipped turn=${trace.turnId} kind=${info.kind} reason=${
                  info.reason ?? "<unknown>"
                } textLen=${(payload.text ?? "").length}`,
              );
            },
          },
        } as never),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to dispatch Symphony inbound to AI turn=${trace.turnId}: ${msg}`);
  } finally {
    // Post-mortem. If nothing reached Symphony and dispatch finished, we hit
    // the long-thinking / GUI-only bug. This warning is the canonical
    // diagnostic — grep for `Symphony NO-DELIVERY` in logs to find every
    // occurrence and correlate with the agent's behavior at that time.
    if (trace.deliverySent === 0) {
      log.warn?.(
        `Symphony NO-DELIVERY turn=${trace.turnId} stream=${normalized.streamId} ` +
          `sessionKey=${route.sessionKey} ` +
          `invocations=${JSON.stringify(trace.invocations)} ` +
          `emptyPayloadsSkipped=${trace.emptyPayloadsSkipped} ` +
          `dispatcherSkipped=${trace.dispatcherSkipped} ` +
          `sendErrors=${trace.sendErrors} ` +
          `deliveryErrors=${trace.deliveryErrors}`,
      );

      // (B) Final apology fallback. Empty-payload skips are an expected
      // intermediate state (the dispatcher may flush nothing on a tool-only
      // turn) — we only apologize when there were genuine send errors or
      // when the dispatcher silently dropped a payload that *did* exist.
      const shouldApologize =
        trace.sendErrors > 0 || trace.dispatcherSkipped > 0 || trace.deliveryErrors > 0;
      if (shouldApologize) {
        try {
          await sendSymphonyMessage({
            cfg,
            accountId,
            streamId: normalized.streamId,
            options: { messageMl: APOLOGY_MESSAGE },
          });
          log.info(`Symphony apology sent turn=${trace.turnId} -> ${normalized.streamId}`);
        } catch (apologyErr) {
          // Even the apology failed. Nothing useful left to do but record it.
          log.error(
            `Symphony apology send FAILED turn=${trace.turnId}: ${
              apologyErr instanceof Error ? apologyErr.message : String(apologyErr)
            }`,
          );
        }
      }
    }
  }
}

/**
 * Sends one MessageML message and, on success, pre-marks the resulting
 * messageId in the dedupe store so the Datafeed echo of our own reply is
 * silently ignored. Bumps `trace.deliverySent` exactly once per call site.
 *
 * Extracted from `delivery.deliver` so the plain-text fallback path can
 * call it a second time without duplicating the dedupe / logging logic.
 */
async function sendAndMarkEcho(params: {
  cfg: OpenClawConfig;
  accountId: string;
  streamId: string;
  messageMl: string;
  trace: TurnTrace;
  kind: string;
  log: ChannelLogSink;
}): Promise<void> {
  const sent = await sendSymphonyMessage({
    cfg: params.cfg,
    accountId: params.accountId,
    streamId: params.streamId,
    options: { messageMl: params.messageMl },
  });
  params.trace.deliverySent += 1;
  params.log.info(
    `Symphony reply sent turn=${params.trace.turnId} kind=${params.kind} msgId=${sent.messageId} -> ${params.streamId}`,
  );
  const sentKey = buildSymphonyDedupeKey({
    accountId: params.accountId,
    streamId: params.streamId,
    messageId: sent.messageId,
  });
  dedupeStore.mark(sentKey);
}

/**
 * Per-turn telemetry used to diagnose the "long-thinking GUI-only" bug:
 * if `deliverySent === 0` after `runInboundReplyTurn` returns, the reply
 * never reached Symphony despite the agent run producing output (which
 * the management UI transcript shows). The remaining counters explain
 * *why* — empty payloads, dispatcher skips, send errors, etc.
 */
type TurnTrace = {
  turnId: string;
  invocations: Record<string, number>;
  deliverySent: number;
  emptyPayloadsSkipped: number;
  dispatcherSkipped: number;
  sendErrors: number;
  deliveryErrors: number;
};

function newTurnTrace(turnId: string): TurnTrace {
  return {
    turnId,
    invocations: {},
    deliverySent: 0,
    emptyPayloadsSkipped: 0,
    dispatcherSkipped: 0,
    sendErrors: 0,
    deliveryErrors: 0,
  };
}

function recordInvocation(trace: TurnTrace, kind: string): void {
  trace.invocations[kind] = (trace.invocations[kind] ?? 0) + 1;
}

function isSenderAllowed(
  sender: NormalizedInboundMessage["sender"],
  allowedUsers: string[],
): boolean {
  for (const entry of allowedUsers) {
    if (/^\d+$/.test(entry) && sender.id === entry) return true;
    if (entry.includes("@") && sender.email === entry) return true;
    if (sender.username && sender.username === entry) return true;
  }
  return false;
}

function adoptLog(sink: ChannelLogSink | undefined): ChannelLogSink {
  if (sink) {
    return sink;
  }
  const fallback = getSymphonyRuntime();
  return {
    info: (m: string) => fallback.log(m),
    warn: (m: string) => (fallback.warn ?? fallback.log)(m),
    error: (m: string) => fallback.error(m),
  };
}
