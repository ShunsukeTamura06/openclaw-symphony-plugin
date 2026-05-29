import { describe, expect, it } from "vitest";
import {
  extractMessageFromEvent,
  normalizeInboundMessage,
  normalizeStreamId,
} from "../src/normalize.js";
import type { DatafeedEventEnvelope, SymphonyMessage } from "../src/symphony/types.js";

const sampleMessage: SymphonyMessage = {
  messageId: "msg-1",
  timestamp: 1_700_000_000_000,
  message: '<messageML>hello <mention uid="999"/> <emoji shortcode="wave"/></messageML>',
  user: {
    id: 12345,
    displayName: "Alice",
    emailAddress: "alice@example.com",
    username: "alice",
  },
  stream: { id: "stream-abc", streamType: "IM" },
  attachments: [
    { id: "att-1", name: "report.pdf", size: 1024, contentType: "application/pdf" },
  ],
};

describe("normalizeInboundMessage", () => {
  it("converts a Symphony message into the OpenClaw-neutral shape", () => {
    const result = normalizeInboundMessage({ message: sampleMessage, accountId: "default" });
    expect(result).not.toBeNull();
    expect(result?.channelId).toBe("symphony");
    expect(result?.accountId).toBe("default");
    expect(result?.streamId).toBe("stream-abc");
    expect(result?.isDirect).toBe(true);
    expect(result?.text).toContain("hello");
    expect(result?.text).toContain(":wave:");
    expect(result?.mentions).toEqual([{ userId: 999 }]);
    expect(result?.sender.id).toBe("12345");
    expect(result?.sender.email).toBe("alice@example.com");
    expect(result?.attachments).toEqual([
      { id: "att-1", filename: "report.pdf", size: 1024, contentType: "application/pdf" },
    ]);
  });

  it("drops messages from self", () => {
    const result = normalizeInboundMessage({
      message: sampleMessage,
      accountId: "default",
      selfUserId: 12345,
    });
    expect(result).toBeNull();
  });

  it("flags isDirect=false for ROOM streams", () => {
    const room: SymphonyMessage = { ...sampleMessage, stream: { id: "r", streamType: "ROOM" } };
    expect(normalizeInboundMessage({ message: room, accountId: "default" })?.isDirect).toBe(false);
  });
});

describe("extractMessageFromEvent", () => {
  it("returns the inner Symphony message for MESSAGESENT events", () => {
    const envelope: DatafeedEventEnvelope = {
      id: "evt-1",
      timestamp: Date.now(),
      type: "MESSAGESENT",
      payload: { messageSent: { message: sampleMessage } },
    };
    expect(extractMessageFromEvent(envelope)?.messageId).toBe("msg-1");
  });

  it("returns null for non-message events", () => {
    const envelope: DatafeedEventEnvelope = {
      id: "evt-2",
      timestamp: Date.now(),
      type: "ROOM_CREATED",
      payload: {},
    };
    expect(extractMessageFromEvent(envelope)).toBeNull();
  });
});

describe("normalizeStreamId", () => {
  it("canonicalizes standard base64 to URL-safe (+ -> -, / -> _)", () => {
    expect(normalizeStreamId("ab+cd/ef")).toBe("ab-cd_ef");
  });

  it("strips trailing '=' padding", () => {
    expect(normalizeStreamId("abcdef==")).toBe("abcdef");
    expect(normalizeStreamId("abcdef=")).toBe("abcdef");
  });

  it("leaves an already URL-safe id unchanged", () => {
    expect(normalizeStreamId("vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA")).toBe(
      "vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA",
    );
  });

  it("clipboard form and Datafeed form of the same stream normalize equal", () => {
    const clipboard = "vTOlxOhTcjFCKZ8GHrSlhX///oRm1dlFdA==";
    const datafeed = "vTOlxOhTcjFCKZ8GHrSlhX___oRm1dlFdA";
    expect(normalizeStreamId(clipboard)).toBe(normalizeStreamId(datafeed));
  });

  it("empty input returns empty", () => {
    expect(normalizeStreamId("")).toBe("");
  });
});
