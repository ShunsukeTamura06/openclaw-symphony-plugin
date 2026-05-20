import { describe, expect, it } from "vitest";
import { MessageDedupeStore, buildSymphonyDedupeKey } from "../src/dedupe.js";

function makeClock(initial = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("MessageDedupeStore", () => {
  it("returns true on first-seen and false on subsequent calls", () => {
    const store = new MessageDedupeStore();
    expect(store.markIfNew("a")).toBe(true);
    expect(store.markIfNew("a")).toBe(false);
    expect(store.markIfNew("b")).toBe(true);
  });

  it("re-accepts a key after the TTL has elapsed", () => {
    const clock = makeClock();
    const store = new MessageDedupeStore({ ttlMs: 1_000, now: clock.now });
    expect(store.markIfNew("k")).toBe(true);
    clock.advance(500);
    expect(store.markIfNew("k")).toBe(false);
    clock.advance(600); // total 1100 > 1000
    expect(store.markIfNew("k")).toBe(true);
  });

  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const store = new MessageDedupeStore({ maxEntries: 2 });
    store.markIfNew("a");
    store.markIfNew("b");
    store.markIfNew("c"); // evicts "a"
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
    expect(store.markIfNew("a")).toBe(true); // a is gone, so first-seen again
  });

  it("re-inserting a key bumps insertion order (LRU on write)", () => {
    const store = new MessageDedupeStore({ maxEntries: 2 });
    store.markIfNew("a");
    store.markIfNew("b");
    store.mark("a"); // re-mark a, bumping it
    store.markIfNew("c"); // should evict "b" (now oldest), not "a"
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
  });

  it("prune() removes expired entries eagerly", () => {
    const clock = makeClock();
    const store = new MessageDedupeStore({ ttlMs: 100, now: clock.now });
    store.markIfNew("a");
    store.markIfNew("b");
    clock.advance(200);
    expect(store.size()).toBe(2);
    expect(store.prune()).toBe(2);
    expect(store.size()).toBe(0);
  });
});

describe("buildSymphonyDedupeKey", () => {
  it("composes accountId, streamId, messageId", () => {
    expect(buildSymphonyDedupeKey({ accountId: "a", streamId: "s", messageId: "m" })).toBe(
      "a:s:m",
    );
  });
});
