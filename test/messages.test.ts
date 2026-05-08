import { describe, expect, it } from "vitest";
import { sendMessage, getAttachment } from "../src/symphony/messages.js";

describe("sendMessage request builder", () => {
  it("targets the agent scope and builds a multipart form with messageML", () => {
    const req = sendMessage({ streamId: "abc/+=", messageMl: "<messageML>hi</messageML>" });
    expect(req.scope).toBe("agent");
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/agent/v4/stream/abc%2F%2B%3D/message/create");
    expect(req.formData).toBeInstanceOf(FormData);
    expect(req.formData?.get("message")).toBe("<messageML>hi</messageML>");
  });

  it("encodes data and attachments", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const req = sendMessage({
      streamId: "s1",
      messageMl: "<messageML>x</messageML>",
      data: { foo: "bar" },
      attachments: [{ filename: "a.bin", content: bytes, contentType: "application/octet-stream" }],
    });
    expect(req.formData?.get("data")).toBe('{"foo":"bar"}');
    const attachment = req.formData?.getAll("attachment");
    expect(attachment).toHaveLength(1);
    expect(attachment?.[0]).toBeInstanceOf(Blob);
  });
});

describe("getAttachment request builder", () => {
  it("returns an agent GET with the right query", () => {
    const req = getAttachment({ streamId: "s1", messageId: "m1", fileId: "f1" });
    expect(req.scope).toBe("agent");
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/agent/v1/stream/s1/attachment");
    expect(req.query).toEqual({ messageId: "m1", fileId: "f1" });
    expect(req.expectStream).toBe(true);
  });
});
