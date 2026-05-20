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
  normalizeInboundMessage,
  type NormalizedInboundMessage,
} from "./normalize.js";
import { disposeClient, getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
import { runDatafeedLoop } from "./symphony/datafeed-loop.js";
import { CHANNEL_ID, type ResolvedSymphonyAccount } from "./types.js";

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
  channelRuntime: FullChannelRuntime | undefined;
  log: ChannelLogSink;
  queue: InboundQueue;
  dedupe: MessageDedupeStore;
}): void {
  const message = extractMessageFromEvent(params.envelope);
  if (!message) {
    return;
  }
  const normalized = normalizeInboundMessage({
    message,
    accountId: params.accountId,
    ...(params.selfUserId !== undefined ? { selfUserId: params.selfUserId } : {}),
  });
  if (!normalized) {
    return;
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
  // Direct messages are implicitly addressed to the bot. For group/room
  // messages, we treat any mention as evidence the message is directed at
  // the bot (upstream group policy decides whether this is the *correct*
  // bot — Symphony rooms typically enforce that already).
  const wasMentioned = normalized.isDirect || normalized.mentions.length > 0;
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
    SenderName: normalized.sender.displayName,
    SenderId: normalized.sender.id,
    SenderUsername: normalized.sender.username,
    WasMentioned: wasMentioned,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: normalized.streamId,
    Timestamp: normalized.timestamp,
    CommandAuthorized: false,
    CommandSource: "text" as const,
  };
  const ctxPayload = channelRuntime.reply.finalizeInboundContext(baseCtx);

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
          // updateLastRoute is what tells OpenClaw "the last inbound on this
          // session came from channel=symphony at to=<streamId>". Without it,
          // the AI reply has no routing target and falls back to the
          // management-UI session transcript instead of being sent back to
          // Symphony.
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
              log.info(
                `Symphony delivery.deliver invoked (kind=${info.kind}, textLen=${text.length}, hasMedia=${Boolean(payload.mediaUrl)})`,
              );
              if (!text && !payload.mediaUrl) {
                return;
              }
              const result = await sendSymphonyMessage({
                cfg,
                accountId,
                streamId: normalized.streamId,
                options: { text },
              });
              log.info(
                `Symphony reply (${info.kind}) sent to ${normalized.streamId} as ${result.messageId}`,
              );
            },
            onError: (err: unknown, info: { kind: string }) => {
              log.error(
                `Symphony reply (${info.kind}) failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          },
        }),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`Failed to dispatch Symphony inbound to AI: ${msg}`);
  }
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
