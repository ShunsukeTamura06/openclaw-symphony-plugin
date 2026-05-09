import type {
  ChannelAccountSnapshot,
  ChannelStatusAdapter,
} from "openclaw/plugin-sdk/channel-contract";
import { isAccountConfigured } from "./config.js";
import { getOrCreateClient } from "./runtime.js";
import type { ResolvedSymphonyAccount, SymphonyAccountProbe } from "./types.js";

export const symphonyStatusAdapter: ChannelStatusAdapter<ResolvedSymphonyAccount, SymphonyAccountProbe> = {
  async probeAccount({ account, timeoutMs }) {
    if (!isAccountConfigured(account)) {
      return { ok: false, message: "missing required Symphony fields" };
    }
    const client = getOrCreateClient(account.accountId ?? "default", account);
    try {
      const session = await Promise.race([client.sessionInfo(), timeout(timeoutMs)]);
      return {
        ok: true,
        selfUserId: session.id,
        ...(session.displayName ? { selfDisplayName: session.displayName } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
  },
};

export function describeSymphonyAccountSnapshot(
  account: ResolvedSymphonyAccount,
): ChannelAccountSnapshot {
  return {
    accountId: account.accountId ?? "default",
    configured: isAccountConfigured(account),
    enabled: account.enabled !== false,
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Symphony probe timed out after ${ms}ms`)), ms);
  });
}
