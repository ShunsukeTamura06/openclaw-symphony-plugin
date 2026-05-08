import { isAccountConfigured } from "./config.js";
import { getOrCreateClient } from "./runtime.js";
import type { ResolvedSymphonyAccount, SymphonyAccountProbe } from "./types.js";

export const symphonyStatusAdapter = {
  describeAccount(account: ResolvedSymphonyAccount | undefined) {
    if (!account) {
      return { configured: false, enabled: false, summary: "Symphony not configured" };
    }
    return {
      configured: isAccountConfigured(account),
      enabled: account.enabled !== false,
      summary: `${account.username} @ ${account.podUrl}`,
    };
  },

  async probeAccount(account: ResolvedSymphonyAccount, timeoutMs = 10_000): Promise<SymphonyAccountProbe> {
    if (!isAccountConfigured(account)) {
      return { ok: false, message: "missing required Symphony fields" };
    }
    const client = getOrCreateClient(account.accountId ?? "default", account);
    try {
      const session = await Promise.race([
        client.sessionInfo(),
        timeout(timeoutMs),
      ]);
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
} as const;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Symphony probe timed out after ${ms}ms`)), ms);
  });
}
