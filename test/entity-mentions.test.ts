import { describe, expect, it } from "vitest";
import { normalizeInboundMessage } from "../src/normalize.js";
import type { SymphonyMessage } from "../src/symphony/types.js";

function makeMessageWithData(dataJson: string | undefined): SymphonyMessage {
  return {
    messageId: "m1",
    timestamp: 1_700_000_000_000,
    message: "<messageML>hi</messageML>",
    user: { userId: 100, displayName: "Alice" },
    stream: { streamId: "S", streamType: "ROOM" },
    ...(dataJson !== undefined ? { data: dataJson } : {}),
  };
}

describe("extractEntityMentions (via normalizeInboundMessage)", () => {
  it("picks userId mentions from a well-formed entity JSON", () => {
    const data = JSON.stringify({
      "0": {
        type: "com.symphony.user.mention",
        id: [{ type: "com.symphony.user.userId", value: "12345" }],
      },
    });
    const normalized = normalizeInboundMessage({
      message: makeMessageWithData(data),
      accountId: "acc",
    });
    expect(normalized?.mentions).toEqual([{ userId: 12345 }]);
  });

  it("returns multiple mentions when the entity JSON has multiple entries", () => {
    const data = JSON.stringify({
      "0": {
        type: "com.symphony.user.mention",
        id: [{ type: "com.symphony.user.userId", value: "111" }],
      },
      "1": {
        type: "com.symphony.user.mention",
        id: [{ type: "com.symphony.user.userId", value: "222" }],
      },
    });
    const normalized = normalizeInboundMessage({
      message: makeMessageWithData(data),
      accountId: "acc",
    });
    expect(normalized?.mentions).toEqual([{ userId: 111 }, { userId: 222 }]);
  });

  it("falls back to MessageML mentions when entity JSON is missing", () => {
    const msg = makeMessageWithData(undefined);
    msg.message = '<messageML>hi <mention uid="999"/></messageML>';
    const normalized = normalizeInboundMessage({ message: msg, accountId: "acc" });
    expect(normalized?.mentions).toEqual([{ userId: 999 }]);
  });

  it("falls back to MessageML when entity JSON is malformed", () => {
    const msg = makeMessageWithData("{ not valid json");
    msg.message = '<messageML><mention uid="42"/></messageML>';
    const normalized = normalizeInboundMessage({ message: msg, accountId: "acc" });
    expect(normalized?.mentions).toEqual([{ userId: 42 }]);
  });

  it("ignores entities whose type is not com.symphony.user.mention", () => {
    const data = JSON.stringify({
      "0": {
        type: "com.symphony.hashTag",
        id: [{ type: "com.symphony.hashTag.value", value: "general" }],
      },
    });
    const msg = makeMessageWithData(data);
    msg.message = "<messageML>plain</messageML>";
    const normalized = normalizeInboundMessage({ message: msg, accountId: "acc" });
    expect(normalized?.mentions).toEqual([]);
  });

  it("skips entries whose id-type is not com.symphony.user.userId", () => {
    const data = JSON.stringify({
      "0": {
        type: "com.symphony.user.mention",
        id: [
          { type: "com.symphony.user.userId", value: "555" },
          { type: "com.symphony.user.emailAddress", value: "x@y.com" },
        ],
      },
    });
    const normalized = normalizeInboundMessage({
      message: makeMessageWithData(data),
      accountId: "acc",
    });
    // Only userId is harvested today (see Q6 for proposed email mention support)
    expect(normalized?.mentions).toEqual([{ userId: 555 }]);
  });

  it("drops mention entries whose value is not a finite number", () => {
    const data = JSON.stringify({
      "0": {
        type: "com.symphony.user.mention",
        id: [{ type: "com.symphony.user.userId", value: "not-a-number" }],
      },
    });
    const normalized = normalizeInboundMessage({
      message: makeMessageWithData(data),
      accountId: "acc",
    });
    expect(normalized?.mentions).toEqual([]);
  });
});
