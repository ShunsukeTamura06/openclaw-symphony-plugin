import { extractMessageFromEvent, normalizeInboundMessage, type NormalizedInboundMessage } from "./normalize.js";
import { getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
import { runDatafeedLoop } from "./symphony/datafeed-loop.js";
import type { ResolvedSymphonyAccount } from "./types.js";

export type SymphonyGatewayContext = {
  accountId: string;
  account: ResolvedSymphonyAccount;
  abortSignal?: AbortSignal;
  setStatus?: (status: { accountId: string; running: boolean; lastError?: string | null; lastStartAt?: number; lastStopAt?: number }) => void;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
  onInboundMessage?: (message: NormalizedInboundMessage) => void | Promise<void>;
};

export const symphonyGatewayAdapter = {
  async startAccount(ctx: SymphonyGatewayContext): Promise<void> {
    const log = ctx.log ?? {
      info: (m: string) => getSymphonyRuntime().log(m),
      warn: (m: string) => getSymphonyRuntime().log(m),
      error: (m: string) => getSymphonyRuntime().error(m),
    };

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
          if (ctx.onInboundMessage) {
            await ctx.onInboundMessage(normalized);
          }
        },
      },
    });
  },

  async stopAccount(ctx: SymphonyGatewayContext): Promise<void> {
    ctx.setStatus?.({
      accountId: ctx.accountId,
      running: false,
      lastStopAt: Date.now(),
    });
    (ctx.log?.info ?? getSymphonyRuntime().log)(
      `Stopped Symphony datafeed for ${ctx.account.username}`,
    );
  },
} as const;
