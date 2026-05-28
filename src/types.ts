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
  /**
   * Whitelist of rooms (group conversations) allowed to interact with
   * OpenClaw via Symphony. Each entry is matched against the inbound
   * message's `streamId` (the conversation/room ID Symphony assigns).
   *
   * Scope: applies ONLY to non-direct conversations (ROOM, MIM, etc.).
   * 1:1 IMs are NOT gated by this list — DMs are governed by
   * `allowedUsers` + `denyDmsByDefault`.
   *
   * Semantics when both `allowedUsers` and `allowedRooms` are set:
   * AND. A non-DM message is processed only if its sender passes
   * `allowedUsers` AND its streamId is in `allowedRooms`.
   *
   * When omitted or empty, all rooms are allowed.
   */
  allowedRooms?: string[];
  /**
   * Default DM (1:1 IM) policy. When `true` (the default), DMs are
   * gated by `allowedUsers`:
   *   - if `allowedUsers` is set, only listed senders can DM the bot
   *   - if `allowedUsers` is unset/empty, ALL DMs are blocked
   *
   * Set to `false` to restore the permissive legacy behavior where
   * any user can DM the bot when `allowedUsers` is unset. The
   * `allowedUsers` filter (when set) still applies in either case.
   *
   * Note: defaults to deny-by-default for safety — empty allowlist
   * should not equal "open to anyone".
   */
  denyDmsByDefault?: boolean;
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
