import { readFileSync } from "node:fs";
import { SymphonyClient } from "./symphony/client.js";
import type { SymphonyAccountConfig } from "./types.js";

type Logger = {
  log: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
};

let logger: Logger | null = null;

export function setSymphonyRuntime(runtime: unknown): void {
  logger = adaptRuntimeLogger(runtime);
}

export function getSymphonyRuntime(): Logger {
  if (logger) {
    return logger;
  }
  return {
    log: (msg: string) => console.log(`[symphony] ${msg}`),
    error: (msg: string) => console.error(`[symphony] ${msg}`),
    warn: (msg: string) => console.warn(`[symphony] ${msg}`),
  };
}

function adaptRuntimeLogger(runtime: unknown): Logger {
  const r = runtime as Record<string, unknown> | null;
  if (!r || typeof r !== "object") {
    return defaultLogger();
  }
  const log = pickLogger(r, "info") ?? pickLogger(r, "log");
  const error = pickLogger(r, "error");
  const warn = pickLogger(r, "warn");
  if (!log || !error) {
    return defaultLogger();
  }
  const adapted: Logger = { log, error };
  if (warn) {
    adapted.warn = warn;
  }
  return adapted;
}

function pickLogger(r: Record<string, unknown>, key: string): ((msg: string) => void) | undefined {
  const direct = r[key];
  if (typeof direct === "function") {
    return (msg: string) => (direct as (m: string) => void)(msg);
  }
  const log = r.log as Record<string, unknown> | undefined;
  if (log && typeof log === "object") {
    const fn = (log as Record<string, unknown>)[key];
    if (typeof fn === "function") {
      return (msg: string) => (fn as (m: string) => void)(msg);
    }
  }
  return undefined;
}

function defaultLogger(): Logger {
  return {
    log: (msg: string) => console.log(`[symphony] ${msg}`),
    error: (msg: string) => console.error(`[symphony] ${msg}`),
    warn: (msg: string) => console.warn(`[symphony] ${msg}`),
  };
}

const clients = new Map<string, SymphonyClient>();

export function getOrCreateClient(accountId: string, account: SymphonyAccountConfig): SymphonyClient {
  const key = clientCacheKey(accountId, account);
  const cached = clients.get(key);
  if (cached) {
    return cached;
  }
  const privateKeyPem = readPrivateKey(account.privateKeyPath);
  const client = new SymphonyClient({
    env: {
      podUrl: account.podUrl,
      agentUrl: account.agentUrl,
      ...(account.relayUrl ? { relayUrl: account.relayUrl } : {}),
    },
    credentials: {
      username: account.username,
      privateKeyPem,
    },
    ...(account.jwtTtlSec !== undefined ? { jwtTtlSec: account.jwtTtlSec } : {}),
  });
  clients.set(key, client);
  return client;
}

export function disposeClient(accountId: string, account: SymphonyAccountConfig): void {
  clients.delete(clientCacheKey(accountId, account));
}

function clientCacheKey(accountId: string, account: SymphonyAccountConfig): string {
  return `${accountId}::${account.podUrl}::${account.username}`;
}

function readPrivateKey(path: string): string {
  if (!path) {
    throw new Error("Symphony account is missing privateKeyPath");
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Symphony private key at ${path}: ${message}`);
  }
}
