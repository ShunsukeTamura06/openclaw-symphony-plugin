import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runDatafeedLoop } from "../src/symphony/datafeed-loop.js";
import { SymphonyClient } from "../src/symphony/client.js";
import type {
  DatafeedEventEnvelope,
  SymphonyMessage,
} from "../src/symphony/types.js";
import { normalizeInboundMessage } from "../src/normalize.js";

/**
 * In-memory Symphony pod that responds to the REST endpoints the plugin
 * actually hits. Backed by a stateful `fetch` impl so SymphonyClient + the
 * datafeed loop run end-to-end without a real network.
 */
function createMockPod(opts?: { sessionUserId?: number; failFirstReadWith?: number }) {
  const podUrl = "https://pod.test.example.com";
  const agentUrl = "https://agent.test.example.com";
  const sessionUserId = opts?.sessionUserId ?? 7_001_001;

  type SentMessage = {
    streamId: string;
    messageMl: string;
    attachmentNames: string[];
  };

  const state = {
    sessionToken: "session-tok-1",
    keyManagerToken: "km-tok-1",
    datafeeds: new Map<string, { id: string; tag?: string }>(),
    cursorByDatafeed: new Map<string, number>(),
    queuedEvents: [] as DatafeedEventEnvelope[],
    sentMessages: [] as SentMessage[],
    authCallCount: 0,
    readCallCount: 0,
    failFirstReadWith: opts?.failFirstReadWith,
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function notFound(url: string): Response {
    return new Response(`unhandled ${url}`, { status: 404 });
  }

  function requireAuth(headers: Headers, scope: "pod" | "agent"): Response | null {
    const session = headers.get("sessionToken");
    if (!session || session !== state.sessionToken) {
      return new Response(JSON.stringify({ message: "auth required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (scope === "agent") {
      const km = headers.get("keyManagerToken");
      if (!km || km !== state.keyManagerToken) {
        return new Response(JSON.stringify({ message: "km required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return null;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const u = new URL(url);
    const path = u.pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit | undefined);

    // Auth: pod and relay/km issuers
    if (method === "POST" && (path === "/login/pubkey/authenticate" || path === "/relay/pubkey/authenticate")) {
      state.authCallCount += 1;
      const isPod = path === "/login/pubkey/authenticate";
      return jsonResponse({ token: isPod ? state.sessionToken : state.keyManagerToken });
    }

    // SessionInfo
    if (method === "GET" && path === "/pod/v2/sessioninfo") {
      const denied = requireAuth(headers, "pod");
      if (denied) return denied;
      return jsonResponse({
        id: sessionUserId,
        username: "openclaw-bot",
        displayName: "OpenClaw Bot",
        emailAddress: "bot@example.com",
      });
    }

    // Datafeed CRUD
    if (path.startsWith("/agent/v5/datafeeds")) {
      const denied = requireAuth(headers, "agent");
      if (denied) return denied;

      // List
      if (method === "GET" && path === "/agent/v5/datafeeds") {
        return jsonResponse(Array.from(state.datafeeds.values()));
      }
      // Create
      if (method === "POST" && path === "/agent/v5/datafeeds") {
        const id = `df-${state.datafeeds.size + 1}`;
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const df = { id, ...(body.tag ? { tag: body.tag as string } : {}) };
        state.datafeeds.set(id, df);
        state.cursorByDatafeed.set(id, 0);
        return jsonResponse(df);
      }
      // Read
      const readMatch = path.match(/^\/agent\/v5\/datafeeds\/([^/]+)\/read$/u);
      if (method === "POST" && readMatch) {
        state.readCallCount += 1;
        if (state.failFirstReadWith && state.readCallCount === 1) {
          return new Response("recreate me", { status: state.failFirstReadWith });
        }
        const dfId = decodeURIComponent(readMatch[1]!);
        const cursor = state.cursorByDatafeed.get(dfId) ?? 0;
        const events = state.queuedEvents.slice(cursor);
        state.cursorByDatafeed.set(dfId, cursor + events.length);
        return jsonResponse({ ackId: `ack-${state.readCallCount}`, events });
      }
      // Delete
      const deleteMatch = path.match(/^\/agent\/v5\/datafeeds\/([^/]+)$/u);
      if (method === "DELETE" && deleteMatch) {
        state.datafeeds.delete(decodeURIComponent(deleteMatch[1]!));
        return new Response(null, { status: 204 });
      }
    }

    // Send message (multipart)
    const sendMatch = path.match(/^\/agent\/v4\/stream\/([^/]+)\/message\/create$/u);
    if (method === "POST" && sendMatch) {
      const denied = requireAuth(headers, "agent");
      if (denied) return denied;
      const streamId = decodeURIComponent(sendMatch[1]!);
      // init.body for FormData under undici is a FormData instance
      const body = init?.body as FormData | undefined;
      const messageMl = body?.get("message")?.toString() ?? "";
      const attachmentNames: string[] = [];
      if (body) {
        for (const value of body.getAll("attachment")) {
          if (value instanceof File) attachmentNames.push(value.name);
        }
      }
      state.sentMessages.push({ streamId, messageMl, attachmentNames });
      const reply: SymphonyMessage = {
        messageId: `msg-${state.sentMessages.length}`,
        timestamp: Date.now(),
        message: messageMl,
        user: { id: sessionUserId, displayName: "OpenClaw Bot" },
        stream: { id: streamId, streamType: "IM" },
      };
      return jsonResponse(reply);
    }

    return notFound(url);
  };

  return {
    podUrl,
    agentUrl,
    fetchImpl,
    state,
    queueMessageEvent(message: SymphonyMessage): void {
      state.queuedEvents.push({
        id: `evt-${state.queuedEvents.length + 1}`,
        timestamp: message.timestamp,
        type: "MESSAGESENT",
        payload: { messageSent: { message } },
      });
    },
    sentMessages: () => state.sentMessages.slice(),
  };
}

function makePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function buildClient(pod: ReturnType<typeof createMockPod>): SymphonyClient {
  return new SymphonyClient({
    env: { podUrl: pod.podUrl, agentUrl: pod.agentUrl },
    credentials: { username: "openclaw-bot", privateKeyPem: makePrivateKeyPem() },
    fetchImpl: pod.fetchImpl,
  });
}

describe("mock Symphony pod (end-to-end client)", () => {
  it("authenticates, fetches sessionInfo, and authorizes downstream calls", async () => {
    const pod = createMockPod({ sessionUserId: 12_345 });
    const client = buildClient(pod);

    const session = await client.sessionInfo();
    expect(session.id).toBe(12_345);
    expect(session.displayName).toBe("OpenClaw Bot");
    // Both pod and relay/km token endpoints were exchanged
    expect(pod.state.authCallCount).toBe(2);
  });

  it("delivers an inbound MESSAGESENT event through the datafeed loop and normalizes it", async () => {
    const pod = createMockPod({ sessionUserId: 99 });
    pod.queueMessageEvent({
      messageId: "M-1",
      timestamp: 1_700_000_000_000,
      message: "<div>hello <mention email=\"bob@example.com\"/></div>",
      user: {
        id: 555,
        displayName: "Alice",
        emailAddress: "alice@example.com",
        username: "alice",
      },
      stream: { id: "stream-IM-1", streamType: "IM" },
    });

    const client = buildClient(pod);
    await client.sessionInfo(); // prime auth

    const controller = new AbortController();
    const seen: DatafeedEventEnvelope[] = [];

    await runDatafeedLoop({
      client,
      tag: "openclaw-test",
      signal: controller.signal,
      handlers: {
        onEvent: (envelope) => {
          seen.push(envelope);
          // stop after receiving the queued event so the loop unwinds cleanly
          controller.abort();
        },
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("MESSAGESENT");

    const message = (seen[0]?.payload as { messageSent: { message: SymphonyMessage } })
      .messageSent.message;
    const normalized = normalizeInboundMessage({ message, accountId: "default", selfUserId: 99 });
    expect(normalized).not.toBeNull();
    expect(normalized?.streamId).toBe("stream-IM-1");
    expect(normalized?.isDirect).toBe(true);
    expect(normalized?.text).toContain("hello");
    expect(normalized?.sender.email).toBe("alice@example.com");
    expect(normalized?.mentions).toEqual([{ email: "bob@example.com" }]);
  });

  it("sends an outbound message and the mock records the multipart payload", async () => {
    const pod = createMockPod();
    const client = buildClient(pod);
    await client.sessionInfo();

    const result = await client.sendMessage({
      streamId: "stream-OUT-1",
      messageMl: "<messageML>hi from openclaw</messageML>",
    });

    expect(result.messageId).toBe("msg-1");
    const sent = pod.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.streamId).toBe("stream-OUT-1");
    expect(sent[0]?.messageMl).toContain("hi from openclaw");
  });

  it("rejects requests when the sessionToken header is wrong (sanity check on the mock)", async () => {
    const pod = createMockPod();
    // Skip auth — call with raw fetchImpl directly
    const res = await pod.fetchImpl(`${pod.podUrl}/pod/v2/sessioninfo`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
