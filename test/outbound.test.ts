import { afterEach, describe, expect, it, vi } from "vitest";

// readFileSync is called by runtime.ts when constructing a SymphonyClient;
// mock it at module-load time so we never need a real PEM on disk.
// vi.mock factories cannot close over outer-module variables (they are hoisted),
// so generate the key inline inside the factory.
vi.mock("node:fs", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return { readFileSync: () => pem };
});

import {
  sendSymphonyMessage,
  symphonyMessageAdapter,
  symphonyOutboundAdapter,
} from "../src/outbound.js";

type CapturedRequest = {
  url: string;
  method: string;
  contentType: string | null;
  formData?: FormData;
  body?: string;
};

function buildFakeFetch(captured: CapturedRequest[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    const contentType = headers.get("content-type");
    const isFormData =
      typeof FormData !== "undefined" && init?.body instanceof FormData;
    const captureEntry: CapturedRequest = {
      url,
      method,
      contentType,
      ...(isFormData ? { formData: init?.body as FormData } : {}),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    captured.push(captureEntry);

    if (url.includes("/login/pubkey/authenticate") || url.includes("/relay/pubkey/authenticate")) {
      return new Response(JSON.stringify({ token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/agent/v4/stream/") && url.endsWith("/message/create")) {
      return new Response(
        JSON.stringify({
          messageId: "MSG-1",
          timestamp: 1_700_000_000_000,
          message: "<messageML/>",
          user: { id: 1 },
          stream: { id: extractStreamId(url), streamType: "IM" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not handled", { status: 404 });
  };
}

function extractStreamId(url: string): string {
  const m = url.match(/\/agent\/v4\/stream\/([^/]+)\/message\/create/u);
  return m ? decodeURIComponent(m[1]!) : "unknown";
}

const baseCfg = {
  channels: {
    symphony: {
      accounts: {
        default: {
          podUrl: "https://pod.test",
          agentUrl: "https://agent.test",
          username: "bot",
          privateKeyPath: "/dummy/path.pem",
        },
      },
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendSymphonyMessage", () => {
  it("posts a multipart message and returns the channel-shaped DeliveryResult", async () => {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(buildFakeFetch(captured));

    const result = await sendSymphonyMessage({
      cfg: baseCfg,
      accountId: "default",
      streamId: "stream-A",
      options: { text: "hello world" },
    });

    expect(result.channel).toBe("symphony");
    expect(result.messageId).toBe("MSG-1");
    expect(result.chatId).toBe("stream-A");

    const sendCall = captured.find((c) => c.url.includes("/message/create"));
    expect(sendCall?.method).toBe("POST");
    expect(sendCall?.formData?.get("message")).toContain("hello world");
  });

  it("throws when the configured account is missing", async () => {
    await expect(
      sendSymphonyMessage({
        cfg: { channels: { symphony: {} } },
        accountId: "ghost",
        streamId: "s",
        options: { text: "x" },
      }),
    ).rejects.toThrow(/account "ghost" is not configured/u);
  });
});

describe("symphonyMessageAdapter", () => {
  it("formatTarget prefixes the stream id", () => {
    expect(symphonyMessageAdapter.formatTarget("ABC123")).toBe("symphony:ABC123");
  });

  it("parseTarget strips known prefixes", () => {
    expect(symphonyMessageAdapter.parseTarget("symphony:stream:ABC")).toEqual({ streamId: "ABC" });
    expect(symphonyMessageAdapter.parseTarget("symphony:im:DEF")).toEqual({ streamId: "DEF" });
    expect(symphonyMessageAdapter.parseTarget("symphony:room:GHI")).toEqual({ streamId: "GHI" });
    expect(symphonyMessageAdapter.parseTarget("symphony:plain")).toEqual({ streamId: "plain" });
  });

  it("parseTarget passes through bare ids unchanged", () => {
    expect(symphonyMessageAdapter.parseTarget("RAW_ID")).toEqual({ streamId: "RAW_ID" });
  });
});

describe("symphonyOutboundAdapter.sendText", () => {
  it("rejects an empty target", async () => {
    await expect(
      symphonyOutboundAdapter.sendText({
        cfg: baseCfg,
        to: "",
        text: "hi",
      }),
    ).rejects.toThrow(/empty target/u);
  });

  it("strips the symphony: prefix before sending", async () => {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(buildFakeFetch(captured));
    await symphonyOutboundAdapter.sendText({
      cfg: baseCfg,
      to: "symphony:stream:STRIP-ME",
      text: "ping",
      accountId: "default",
    });

    const sendCall = captured.find((c) => c.url.includes("/message/create"));
    expect(sendCall?.url).toContain("/agent/v4/stream/STRIP-ME/message/create");
  });

  it("attaches a data: URL as a multipart attachment", async () => {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(buildFakeFetch(captured));
    const dataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50]).toString("base64")}`;
    await symphonyOutboundAdapter.sendText({
      cfg: baseCfg,
      to: "STREAM-X",
      text: "with image",
      mediaUrl: dataUrl,
      accountId: "default",
    });

    const sendCall = captured.find((c) => c.url.includes("/message/create"));
    const attachments = sendCall?.formData?.getAll("attachment") ?? [];
    expect(attachments).toHaveLength(1);
    expect((attachments[0] as File).name).toBe("attachment.png");
  });

  it("attaches a file:// URL via the injected reader", async () => {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(buildFakeFetch(captured));
    const reader = vi.fn(async () => Buffer.from("file-bytes", "utf8"));

    await symphonyOutboundAdapter.sendText({
      cfg: baseCfg,
      to: "STREAM-Y",
      text: "with file",
      mediaUrl: "file:///tmp/report.pdf",
      accountId: "default",
      mediaReadFile: reader,
    });

    expect(reader).toHaveBeenCalledWith("/tmp/report.pdf");
    const sendCall = captured.find((c) => c.url.includes("/message/create"));
    const attachments = sendCall?.formData?.getAll("attachment") ?? [];
    expect(attachments).toHaveLength(1);
    expect((attachments[0] as File).name).toBe("report.pdf");
  });

  it("silently drops unsupported mediaUrl schemes (https://) and still sends the text", async () => {
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(buildFakeFetch(captured));
    await symphonyOutboundAdapter.sendText({
      cfg: baseCfg,
      to: "STREAM-Z",
      text: "no attachment",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    const sendCall = captured.find((c) => c.url.includes("/message/create"));
    const attachments = sendCall?.formData?.getAll("attachment") ?? [];
    expect(attachments).toHaveLength(0);
    expect(sendCall?.formData?.get("message")).toContain("no attachment");
  });
});
