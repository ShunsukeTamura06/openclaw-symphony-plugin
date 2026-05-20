/**
 * TTL + LRU bounded message dedupe store.
 *
 * Symphony Datafeed v5 can re-deliver the same MESSAGESENT event when the
 * ackId is lost (reconnects, feed recreation, transient network errors).
 * Without dedupe the bot would reply twice to the same user message.
 *
 * Semantics:
 *   - `markIfNew(key)` returns true the first time a key is seen, false
 *     thereafter (until the TTL elapses).
 *   - Entries are evicted lazily on access and proactively when the store
 *     exceeds `maxEntries` (oldest insertion-order entry removed first).
 *
 * The interface stays small so it can be swapped for a SQLite-backed
 * implementation later without touching call sites.
 */
export type MessageDedupeStoreOptions = {
  /** Default TTL in ms applied when `markIfNew(key)` is called without an override. */
  ttlMs?: number;
  /** Soft cap on retained entries. When exceeded, the oldest entry is evicted. */
  maxEntries?: number;
  /** Override for clock (testing). */
  now?: () => number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class MessageDedupeStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  constructor(options: MessageDedupeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  has(key: string): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Mark `key` as seen if it wasn't already (or its previous entry has expired).
   * Returns true on first-seen, false on duplicate.
   */
  markIfNew(key: string, ttlMs?: number): boolean {
    if (this.has(key)) {
      return false;
    }
    this.set(key, ttlMs);
    return true;
  }

  /** Force-mark a key (used after successful processing if the caller wants explicit control). */
  mark(key: string, ttlMs?: number): void {
    this.set(key, ttlMs);
  }

  size(): number {
    return this.entries.size;
  }

  /** Drop expired entries. Optional — `has`/`markIfNew` already evict lazily. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private set(key: string, ttlMs?: number): void {
    const expiresAt = this.now() + (ttlMs ?? this.ttlMs);
    // Reinsert to bump LRU/insertion order.
    this.entries.delete(key);
    this.entries.set(key, expiresAt);
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
  }
}

export function buildSymphonyDedupeKey(params: {
  accountId: string;
  streamId: string;
  messageId: string;
}): string {
  return `${params.accountId}:${params.streamId}:${params.messageId}`;
}
