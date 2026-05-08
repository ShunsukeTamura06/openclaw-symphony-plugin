import { CHANNEL_ID, DEFAULT_ACCOUNT_ID, type SymphonyAccountConfig } from "./types.js";

type AnyConfig = Record<string, unknown> | undefined;

function readChannelsBlock(cfg: AnyConfig): Record<string, unknown> | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const channels = (cfg as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return undefined;
  }
  const symphony = (channels as Record<string, unknown>)[CHANNEL_ID];
  return symphony && typeof symphony === "object" ? (symphony as Record<string, unknown>) : undefined;
}

export function resolveDefaultAccountId(cfg: AnyConfig): string {
  const block = readChannelsBlock(cfg);
  const explicit = block?.defaultAccount;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  const accounts = block?.accounts;
  if (accounts && typeof accounts === "object") {
    const keys = Object.keys(accounts);
    if (keys.length > 0 && keys[0]) {
      return keys[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

export function listAccountIds(cfg: AnyConfig): string[] {
  const block = readChannelsBlock(cfg);
  const accounts = block?.accounts;
  if (accounts && typeof accounts === "object") {
    const keys = Object.keys(accounts);
    if (keys.length > 0) {
      return keys;
    }
  }
  if (block && hasInlineAccountFields(block)) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

function hasInlineAccountFields(block: Record<string, unknown>): boolean {
  return typeof block.podUrl === "string" && typeof block.username === "string";
}

export function getAccountConfig(
  cfg: AnyConfig,
  accountId: string | null | undefined,
): SymphonyAccountConfig | undefined {
  const block = readChannelsBlock(cfg);
  if (!block) {
    return undefined;
  }
  const id = accountId ?? resolveDefaultAccountId(cfg);
  const accounts = block.accounts as Record<string, unknown> | undefined;
  if (accounts && typeof accounts === "object") {
    const found = accounts[id];
    if (found && typeof found === "object") {
      return found as SymphonyAccountConfig;
    }
  }
  if (id === DEFAULT_ACCOUNT_ID && hasInlineAccountFields(block)) {
    const { podUrl, agentUrl, relayUrl, username, privateKeyPath, enabled, datafeedTag, jwtTtlSec } =
      block as Record<string, unknown>;
    return {
      podUrl: String(podUrl),
      agentUrl: String(agentUrl ?? podUrl),
      ...(typeof relayUrl === "string" ? { relayUrl } : {}),
      username: String(username),
      privateKeyPath: String(privateKeyPath ?? ""),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(typeof datafeedTag === "string" ? { datafeedTag } : {}),
      ...(typeof jwtTtlSec === "number" ? { jwtTtlSec } : {}),
    };
  }
  return undefined;
}

export function isAccountConfigured(account: SymphonyAccountConfig | undefined): boolean {
  if (!account) {
    return false;
  }
  return Boolean(account.podUrl && account.agentUrl && account.username && account.privateKeyPath);
}
