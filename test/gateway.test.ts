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
      denyDmsByDefault: false,
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
      denyDmsByDefault: false,
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc",
      denyDmsByDefault: false,
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
      denyDmsByDefault: false,
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });
    handleInboundEnvelope({
      envelope,
      cfg: {} as never,
      accountId: "acc-B",
      denyDmsByDefault: false,
      channelRuntime: undefined,
      log: silentLog,
      queue,
      dedupe,
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });

  // Refs Q4 (docs/review-2026-05-20.md) — early mention filter
  describe("early group mention filter", () => {
    const SELF_UID = 7777;

    function makeRoomMessage(mentions: Array<{ userId: number }>): SymphonyMessage {
      return {
        messageId: "room-msg",
        timestamp: 1,
        message: "<messageML>hi room</messageML>",
        user: { userId: 100, displayName: "Alice" },
        stream: { streamId: "room-A", streamType: "ROOM" },
        data:
          mentions.length > 0
            ? JSON.stringify(
                Object.fromEntries(
                  mentions.map((m, i) => [
                    String(i),
                    {
                      type: "com.symphony.user.mention",
                      id: [{ type: "com.symphony.user.userId", value: String(m.userId) }],
                    },
                  ]),
                ),
              )
            : undefined,
      };
    }

    it("drops a room message that does not @-mention the bot", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessage([])),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("drops a room message whose mentions target another user, not the bot", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessage([{ userId: 999 }])),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("accepts a room message that @-mentions the bot", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessage([{ userId: SELF_UID }])),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("does not apply the mention filter to direct messages", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        denyDmsByDefault: false,
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("allowedRooms filter", () => {
    const SELF_UID = 7777;

    function makeRoomMessageWithMention(streamId: string): SymphonyMessage {
      // include a mention of SELF_UID so the room-mention filter doesn't drop it
      return {
        messageId: `msg-${streamId}`,
        timestamp: 1,
        message: "<messageML>hi room</messageML>",
        user: { userId: 100, displayName: "Alice" },
        stream: { streamId, streamType: "ROOM" },
        data: JSON.stringify({
          "0": {
            type: "com.symphony.user.mention",
            id: [{ type: "com.symphony.user.userId", value: String(SELF_UID) }],
          },
        }),
      };
    }

    it("drops a room message whose streamId is NOT in allowedRooms", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("room-Z")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: ["room-A", "room-B"],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("accepts a room message whose streamId IS in allowedRooms", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("room-A")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: ["room-A", "room-B"],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT gate DMs (IM streamType bypasses allowedRooms entirely)", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      // makeSymphonyMessage produces an IM by default with stream-A.
      // denyDmsByDefault: false so the DM-deny safety doesn't fire — this
      // test is specifically about allowedRooms NOT gating DMs.
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: ["only-this-room"], // stream-A is NOT here
        denyDmsByDefault: false,
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("empty allowedRooms => all rooms allowed (same as omitted)", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("any-room")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: [],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("composes with allowedUsers as AND (both must pass)", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      // sender userId=100, allowedUsers contains "100" -> user OK
      // streamId=room-X, allowedRooms=["room-A"] -> room NOT OK
      // Expect: blocked
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("room-X")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedUsers: ["100"],
        allowedRooms: ["room-A"],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("matches across base64 forms: clipboard '/' equals Datafeed '_'", () => {
      // Symphony web client copy gives standard base64 (slash). Datafeed
      // delivers URL-safe (underscore). Both should match.
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      // Inbound streamId is URL-safe (this is what Datafeed sends).
      const inboundStreamId = "vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA";
      // Operator pasted the clipboard (standard base64) form.
      const configEntry = "vTOlxOhTcjFCKZ8GHrSlhX///oRm1dlFdA";
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention(inboundStreamId)),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: [configEntry],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("matches across base64 forms: standard '+' equals URL-safe '-'", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("abc-def_GHI")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: ["abc+def/GHI=="],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("trailing '=' padding is ignored when matching", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("room-A")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedRooms: ["room-A=="],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("composes with allowedUsers: both pass => message goes through", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeRoomMessageWithMention("room-A")),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: SELF_UID,
        allowedUsers: ["100"],
        allowedRooms: ["room-A"],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("denyDmsByDefault (DM policy)", () => {
    it("blocks DMs when default policy applies AND allowedUsers is unset (the new default)", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        // makeSymphonyMessage produces an IM stream by default
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        // denyDmsByDefault omitted => default true
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("blocks DMs when denyDmsByDefault is explicitly true AND allowedUsers is empty", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        denyDmsByDefault: true,
        allowedUsers: [],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it("allows DMs when sender is in allowedUsers (regardless of denyDmsByDefault)", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      // makeSymphonyMessage defaults to sender { id: 100 }
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        denyDmsByDefault: true,
        allowedUsers: ["100"],
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("denyDmsByDefault: false restores legacy permissive DM behavior", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(makeSymphonyMessage()),
        cfg: {} as never,
        accountId: "acc",
        denyDmsByDefault: false,
        // allowedUsers omitted -> empty
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });

    it("denyDmsByDefault does NOT affect non-DM (room) traffic", () => {
      const queue = new InboundQueue();
      const dedupe = new MessageDedupeStore();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockImplementation(() => undefined);
      // a room message mentioning the bot (SELF_UID = 7777) so the
      // group-mention filter doesn't drop it
      const roomMsg: SymphonyMessage = {
        messageId: "room-msg",
        timestamp: 1,
        message: "<messageML>hi</messageML>",
        user: { userId: 100, displayName: "Alice" },
        stream: { streamId: "any-room", streamType: "ROOM" },
        data: JSON.stringify({
          "0": {
            type: "com.symphony.user.mention",
            id: [{ type: "com.symphony.user.userId", value: "7777" }],
          },
        }),
      };
      handleInboundEnvelope({
        envelope: makeMessageSentEnvelope(roomMsg),
        cfg: {} as never,
        accountId: "acc",
        selfUserId: 7777,
        // denyDmsByDefault default (true) — should not block a room msg
        // allowedUsers unset — would block DMs but this is a ROOM
        channelRuntime: undefined,
        log: silentLog,
        queue,
        dedupe,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    });
  });
});

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
