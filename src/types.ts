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
  /**
   * Whitelist of users allowed to interact with OpenClaw via Symphony.
   * Each entry is matched against the sender as follows:
   *   - digits only  → Symphony userId (e.g. "86311662783854")
   *   - contains "@" → email address
   *   - otherwise    → username
   * When omitted or empty, all users are allowed.
   */
  allowedUsers?: string[];
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
