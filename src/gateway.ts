import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { sendSymphonyMessage } from "./outbound.js";
import {
  extractMessageFromEvent,
  normalizeInboundMessage,
  type NormalizedInboundMessage,
} from "./normalize.js";
import { getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
import { runDatafeedLoop } from "./symphony/datafeed-loop.js";
import type { ResolvedSymphonyAccount } from "./types.js";

type ChannelRuntimeSurface = {
  routing?: {
    resolveAgentRoute: (input: {
      cfg: unknown;
      channel: string;
      accountId?: string | null;
      peer?: { kind: "direct" | "group"; id: string } | null;
    }) => {
      agentId: string;
      sessionKey: string;
      mainSessionKey: string;
      lastRoutePolicy: "main" | "session";
    };
  };
  session?: {
    resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
    recordInboundSession: unknown;
  };
  reply?: {
    finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T, opts?: unknown) => T;
    dispatchReplyWithBufferedBlockDispatcher: unknown;
  };
};

export type SymphonyGatewayContext = {
  cfg: unknown;
  accountId: string;
  account: ResolvedSymphonyAccount;
  abortSignal?: AbortSignal;
  setStatus?: (status: {
    accountId: string;
    running: boolean;
    lastError?: string | null;
    lastStartAt?: number;
    lastStopAt?: number;
  }) => void;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
  channelRuntime?: ChannelRuntimeSurface;
};

export const symphonyGatewayAdapter = {
  async startAccount(ctx: SymphonyGatewayContext): Promise<void> {
    const log = adoptLog(ctx);

    if (!ctx.account.privateKeyPath) {
      ctx.setStatus?.({
        accountId: ctx.accountId,
        running: false,
        lastError: "privateKeyPath is required",
      });
      return;
    }

    ctx.setStatus?.({
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
      log.error?.(`Symphony authentication failed: ${msg}`);
      ctx.setStatus?.({ accountId: ctx.accountId, running: false, lastError: msg });
      return;
    }

    const channelRuntime = ctx.channelRuntime;
    if (!channelRuntime?.routing || !channelRuntime.session || !channelRuntime.reply) {
      log.warn?.(
        "channelRuntime not available — Symphony will receive events but cannot dispatch to AI",
      );
    }

    const tag = ctx.account.datafeedTag ?? `openclaw-${ctx.accountId}`;

    await runDatafeedLoop({
      client,
      tag,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      handlers: {
        onLog: (m) => log.info(m),
        onError: (e) => log.error?.(e instanceof Error ? e.message : String(e)),
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
    const log = adoptLog(ctx);
    ctx.setStatus?.({
      accountId: ctx.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
    log.info(`Stopped Symphony datafeed for ${ctx.account.username}`);
  },
};

async function dispatchInboundToAi(params: {
  cfg: unknown;
  accountId: string;
  normalized: NormalizedInboundMessage;
  channelRuntime: ChannelRuntimeSurface | undefined;
  log: AdoptedLog;
}): Promise<void> {
  const { cfg, accountId, normalized, channelRuntime, log } = params;

  if (!channelRuntime?.routing || !channelRuntime.session || !channelRuntime.reply) {
    return;
  }

  const peerKind = normalized.isDirect ? ("direct" as const) : ("group" as const);
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg,
    channel: "symphony",
    accountId,
    peer: { kind: peerKind, id: normalized.streamId },
  });

  const storePath = channelRuntime.session.resolveStorePath(undefined, {
    agentId: route.agentId,
  });

  const senderLabel = normalized.sender.displayName ?? normalized.sender.email ?? normalized.sender.id;
  const baseCtx: Record<string, unknown> = {
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
    await runInboundReplyTurn({
      channel: "symphony",
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
          channel: "symphony",
          accountId,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload: ctxPayload as never,
          recordInboundSession: channelRuntime.session!.recordInboundSession as never,
          dispatchReplyWithBufferedBlockDispatcher:
            channelRuntime.reply!.dispatchReplyWithBufferedBlockDispatcher as never,
          delivery: {
            deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
              const text = payload.text ?? "";
              if (!text && !payload.mediaUrl) {
                return;
              }
              await sendSymphonyMessage({
                cfg: cfg as Record<string, unknown> | undefined,
                accountId,
                streamId: normalized.streamId,
                options: { text },
              });
            },
            onError: (err: unknown, info: { kind: string }) => {
              log.error?.(
                `Symphony reply (${info.kind}) failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          },
        } as never),
      } as never,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error?.(`Failed to dispatch Symphony inbound to AI: ${msg}`);
  }
}

type AdoptedLog = {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

function adoptLog(ctx: SymphonyGatewayContext): AdoptedLog {
  if (ctx.log?.info) {
    return ctx.log;
  }
  const fallback = getSymphonyRuntime();
  return {
    info: (m: string) => fallback.log(m),
    warn: (m: string) => (fallback.warn ?? fallback.log)(m),
    error: (m: string) => fallback.error(m),
  };
}
