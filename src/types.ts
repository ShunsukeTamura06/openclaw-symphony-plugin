export const CHANNEL_ID = "symphony" as const;
export const DEFAULT_ACCOUNT_ID = "default" as const;

export type SymphonyAccountConfig = {
  podUrl: string;
  agentUrl: string;
  relayUrl?: string;
  username: string;
  privateKeyPath: string;
  enabled?: boolean;
  /**
   * Override datafeed tag (used to find existing feeds across restarts).
   * Default: `openclaw-<accountId>`.
   */
  datafeedTag?: string;
  jwtTtlSec?: number;
};

export type ResolvedSymphonyAccount = SymphonyAccountConfig & {
  accountId?: string | null;
};

export type SymphonyAccountProbe = {
  ok: boolean;
  selfUserId?: number;
  selfDisplayName?: string;
  message?: string;
};

export type SymphonyChannelConfig = {
  defaultAccount?: string;
  accounts?: Record<string, SymphonyAccountConfig>;
} & Partial<SymphonyAccountConfig>;
