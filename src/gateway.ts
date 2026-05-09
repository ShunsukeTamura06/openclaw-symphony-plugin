import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelGatewayContext,
  ChannelLogSink,
} from "openclaw/plugin-sdk/channel-contract";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { sendSymphonyMessage } from "./outbound.js";
import {
  extractMessageFromEvent,
  normalizeInboundMessage,
  type NormalizedInboundMessage,
} from "./normalize.js";
import { getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
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
        onEvent: async (envelope) => {
          const message = extractMessageFromEvent(envelope);
          if (!message) {
            return;
          }
          const normalized = normalizeInboundMessage({
            message,
            accountId: ctx.accountId,
            ...(selfUserId !== undefined ? { selfUserId } : {}),
          });
          if (!normalized) {
            return;
          }
          await dispatchInboundToAi({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            normalized,
            channelRuntime,
            log,
          });
        },
      },
    });
  },

  async stopAccount(ctx: SymphonyGatewayContext): Promise<void> {
    const log = adoptLog(ctx.log);
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
    log.info(`Stopped Symphony datafeed for ${ctx.account.username}`);
  },
};

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
    CommandAuthorized: false,
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
          delivery: {
            deliver: async (payload: ReplyPayload) => {
              const text = payload.text ?? "";
              if (!text && !payload.mediaUrl) {
                return;
              }
              await sendSymphonyMessage({
                cfg,
                accountId,
                streamId: normalized.streamId,
                options: { text },
              });
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
