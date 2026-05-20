import { describe, expect, it, vi } from "vitest";
import { MessageDedupeStore } from "../src/dedupe.js";
import { handleInboundEnvelope } from "../src/gateway.js";
import { InboundQueue } from "../src/inbound-queue.js";
import type { DatafeedEventEnvelope, SymphonyMessage } from "../src/symphony/types.js";

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function makeMessageSentEnvelope(message: SymphonyMessage): DatafeedEventEnvelope {
  return {
    id: `evt-${message.messageId}`,
    timestamp: message.timestamp,
    type: "MESSAGESENT",
    payload: { messageSent: { message } },
  };
}

function makeSymphonyMessage(overrides: Partial<SymphonyMessage> = {}): SymphonyMessage {
  return {
    messageId: "msg-1",
    timestamp: 1_700_000_000_000,
    message: "<messageML>hello</messageML>",
    user: { id: 100, displayName: "Alice", emailAddress: "alice@example.com" },
    stream: { id: "stream-A", streamType: "IM" },
    ...overrides,
  };
}

describe("handleInboundEnvelope", () => {
  it("ignores non-MESSAGESENT events", () => {
    const queue = new InboundQueue();
    const dedupe = new MessageDedupeStore();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    handleInboundEnvelope({
      envelope: { id: "x", timestamp: 1, type: "ROOM_CREATED", payload: {} },
      cfg: {} as never,
      accountId: "acc",
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("drops messages from self", () => {
    const queue = new InboundQueue();
    const dedupe = new MessageDedupeStore();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    handleInboundEnvelope({
      envelope: makeMessageSentEnvelope(makeSymphonyMessage({ user: { id: 42 } })),
      cfg: {} as never,
      accountId: "acc",
      selfUserId: 42,
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not block on AI dispatch — returns synchronously after enqueue", async () => {
    const queue = new InboundQueue();
    const dedupe = new MessageDedupeStore();

    let dispatchStarted = false;
    let dispatchFinished = false;
    const release = makeDeferred();
    const slowEnqueue = vi.spyOn(queue, "enqueue").mockImplementation((job) => {
      // Simulate a slow AI dispatch — handleInboundEnvelope must NOT await this.
      void Promise.resolve().then(async () => {
        dispatchStarted = true;
        await job.run();
      });
      // Actually run the underlying job too so drain() works
      void job
        .run()
        .then(() => {
          dispatchFinished = true;
        })
        .catch(() => undefined);
    });

    const slowRuntime = {
      routing: {
        resolveAgentRoute: () => {
          dispatchStarted = true;
          return release.promise as never;
        },
      },
    };

    handleInboundEnvelope({
      envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
      cfg: {} as never,
      accountId: "acc",
      channelRuntime: slowRuntime as never,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(slowEnqueue).toHaveBeenCalledTimes(1);
    expect(dispatchFinished).toBe(false);

    release.resolve();
    await new Promise((r) => setImmediate(r));
  });

  it("dedupes a second event with the same accountId+streamId+messageId", () => {
    const queue = new InboundQueue();
    const dedupe = new MessageDedupeStore();
    const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);

    const envelope = makeMessageSentEnvelope(makeSymphonyMessage());
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc",
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc",
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe across accounts (same messageId, different accountId)", () => {
    const queue = new InboundQueue();
    const dedupe = new MessageDedupeStore();
    const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);

    const envelope = makeMessageSentEnvelope(makeSymphonyMessage());
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc-A",
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc-B",
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });
});

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
