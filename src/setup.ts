import type {
  ChannelSetupAdapter,
  ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { isAccountConfigured } from "./config.js";
import { CHANNEL_ID, type SymphonyAccountConfig } from "./types.js";

export const symphonySetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig({ cfg, accountId, input }) {
    return writeSymphonyAccount({ cfg, accountId, input });
  },
  validateInput({ input }) {
    if (input.privateKey !== undefined && !input.privateKey.includes("PRIVATE KEY")) {
      return "Symphony privateKey must be a PEM-encoded RSA private key";
    }
    return null;
  },
};

function writeSymphonyAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;

  const next = structuredClone(cfg) as Record<string, unknown>;
  const channels = (next.channels = (next.channels as Record<string, unknown> | undefined) ?? {});
  const symphony = (channels[CHANNEL_ID] = (channels[CHANNEL_ID] as Record<string, unknown> | undefined) ?? {});
  const accounts = (symphony.accounts = (symphony.accounts as Record<string, unknown> | undefined) ?? {});

  const existing = (accounts[accountId] as Partial<SymphonyAccountConfig> | undefined) ?? {};
  const merged: Partial<SymphonyAccountConfig> = { ...existing };

  // Map the generic ChannelSetupInput bag to Symphony account fields.
  // Symphony has no perfect 1:1 with the SDK bag; use the closest standard fields.
  if (input.httpUrl) merged.podUrl = input.httpUrl;
  if (input.baseUrl) merged.agentUrl = input.baseUrl;
  if (input.userId) merged.username = input.userId;
  if (input.tokenFile) merged.privateKeyPath = input.tokenFile;

  accounts[accountId] = merged;
  return next as OpenClawConfig;
}

export function describeSymphonyAccount(account: SymphonyAccountConfig | undefined): {
  configured: boolean;
  summary: string;
} {
  return {
    configured: isAccountConfigured(account),
    summary: account
      ? `Symphony bot ${account.username} @ ${account.podUrl}`
      : "Symphony account not configured",
  };
}
