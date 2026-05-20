import { describe, expect, it, vi } from "vitest";
import { InboundQueue, type InboundJob } from "../src/inbound-queue.js";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void };

function defer(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeJob(params: {
  streamId: string;
  messageId: string;
  accountId?: string;
  run: () => Promise<void>;
}): InboundJob {
  return {
    accountId: params.accountId ?? "acc",
    streamId: params.streamId,
    messageId: params.messageId,
    run: params.run,
  };
}

describe("InboundQueue", () => {
  it("serializes jobs on the same stream in enqueue order", async () => {
    const queue = new InboundQueue();
    const order: string[] = [];
    const d1 = defer();
    const d2 = defer();

    queue.enqueue(
      makeJob({
        streamId: "S",
        messageId: "m1",
        run: async () => {
          order.push("start1");
          await d1.promise;
          order.push("end1");
        },
      }),
    );
    queue.enqueue(
      makeJob({
        streamId: "S",
        messageId: "m2",
        run: async () => {
          order.push("start2");
          await d2.promise;
          order.push("end2");
        },
      }),
    );

    // job2 must NOT have started yet
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start1"]);

    d1.resolve();
    d2.resolve();
    await queue.drain();
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("runs jobs on different streams concurrently", async () => {
    const queue = new InboundQueue();
    const seen: string[] = [];
    const dA = defer();
    const dB = defer();

    queue.enqueue(
      makeJob({
        streamId: "A",
        messageId: "1",
        run: async () => {
          seen.push("A-start");
          await dA.promise;
          seen.push("A-end");
        },
      }),
    );
    queue.enqueue(
      makeJob({
        streamId: "B",
        messageId: "1",
        run: async () => {
          seen.push("B-start");
          await dB.promise;
          seen.push("B-end");
        },
      }),
    );

    // both should have started before either finishes
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toContain("A-start");
    expect(seen).toContain("B-start");
    expect(seen).not.toContain("A-end");
    expect(seen).not.toContain("B-end");

    dA.resolve();
    dB.resolve();
    await queue.drain();
    expect(seen).toEqual(expect.arrayContaining(["A-end", "B-end"]));
  });

  it("isolates job errors via onError and keeps the chain running", async () => {
    const errors: unknown[] = [];
    const queue = new InboundQueue({ onError: (e) => errors.push(e) });
    const order: string[] = [];

    queue.enqueue(
      makeJob({
        streamId: "S",
        messageId: "boom",
        run: async () => {
          throw new Error("boom");
        },
      }),
    );
    queue.enqueue(
      makeJob({
        streamId: "S",
        messageId: "ok",
        run: async () => {
          order.push("ran");
        },
      }),
    );

    await queue.drain();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(order).toEqual(["ran"]);
  });

  it("drain() returns when all enqueued jobs settle", async () => {
    const queue = new InboundQueue();
    expect(queue.activeChains()).toBe(0);
    queue.enqueue(makeJob({ streamId: "X", messageId: "1", run: async () => undefined }));
    queue.enqueue(makeJob({ streamId: "Y", messageId: "1", run: async () => undefined }));
    expect(queue.activeChains()).toBeGreaterThan(0);
    await queue.drain();
    expect(queue.activeChains()).toBe(0);
  });

  it("does not surface unhandled rejections for throwing jobs", async () => {
    const handler = vi.fn();
    process.once("unhandledRejection", handler);

    const queue = new InboundQueue({ onError: () => undefined });
    queue.enqueue(
      makeJob({
        streamId: "Z",
        messageId: "1",
        run: async () => {
          throw new Error("silent");
        },
      }),
    );
    await queue.drain();

    // Give Node a microtask + macrotask to bubble unhandled rejections, if any.
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});
