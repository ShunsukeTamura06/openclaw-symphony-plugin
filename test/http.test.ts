import { describe, expect, it } from "vitest";
import { SymphonyHttpError, symphonyFetch } from "../src/symphony/http.js";
import type { SymphonyTokens } from "../src/symphony/types.js";

const tokens: SymphonyTokens = {
  sessionToken: "S",
  keyManagerToken: "K",
  issuedAt: 0,
  expiresAt: Date.now() + 600_000,
};

const env = { podUrl: "https://pod.example.com", agentUrl: "https://agent.example.com" };

describe("symphonyFetch", () => {
  it("attaches sessionToken for pod scope and both tokens for agent scope", async () => {
    const seen: Array<Record<string, string>> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    };

    await symphonyFetch({
      env,
      tokens,
      request: { scope: "pod", method: "GET", path: "/pod/v2/sessioninfo" },
      fetchImpl: fakeFetch,
    });
    await symphonyFetch({
      env,
      tokens,
      request: { scope: "agent", method: "GET", path: "/agent/v5/datafeeds" },
      fetchImpl: fakeFetch,
    });

    const podHeaders = seen[0] ?? {};
    const agentHeaders = seen[1] ?? {};
    expect(podHeaders.sessionToken).toBe("S");
    expect(podHeaders.keyManagerToken).toBeUndefined();
    expect(agentHeaders.sessionToken).toBe("S");
    expect(agentHeaders.keyManagerToken).toBe("K");
  });

  it("builds a URL with query params and sends JSON body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as URL).toString();
      capturedBody = init?.body;
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    };

    await symphonyFetch({
      env,
      tokens,
      request: {
        scope: "agent",
        method: "POST",
        path: "/agent/v5/datafeeds",
        query: { tag: "openclaw" },
        body: { foo: "bar" },
      },
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).toBe("https://agent.example.com/agent/v5/datafeeds?tag=openclaw");
    expect(JSON.parse(capturedBody as string)).toEqual({ foo: "bar" });
  });

  it("retries on 503 and eventually succeeds", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("upstream", { status: 503, statusText: "Service Unavailable" });
      }
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await symphonyFetch<{ ok: number }>({
      env,
      tokens,
      request: { scope: "pod", method: "GET", path: "/x" },
      fetchImpl: fakeFetch,
      retry: { initialBackoffMs: 1, maxBackoffMs: 2, maxAttempts: 5 },
    });
    expect(result).toEqual({ ok: 1 });
    expect(calls).toBe(3);
  });

  it("refreshes tokens once on 401 and retries", async () => {
    let calls = 0;
    let refreshed = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("expired", { status: 401, statusText: "Unauthorized" });
      }
      return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await symphonyFetch<{ ok: number }>({
      env,
      tokens,
      request: { scope: "pod", method: "GET", path: "/x" },
      fetchImpl: fakeFetch,
      refreshTokens: async () => {
        refreshed += 1;
        return { ...tokens, sessionToken: "S2", keyManagerToken: "K2" };
      },
    });
    expect(result).toEqual({ ok: 1 });
    expect(refreshed).toBe(1);
    expect(calls).toBe(2);
  });

  it("throws SymphonyHttpError on non-retryable failure", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('{"code":400,"message":"bad"}', { status: 400, statusText: "Bad Request" });

    await expect(
      symphonyFetch({
        env,
        tokens,
        request: { scope: "pod", method: "GET", path: "/x" },
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(SymphonyHttpError);
  });
});
