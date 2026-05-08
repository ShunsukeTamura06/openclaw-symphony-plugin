import type { SymphonyTokens } from "./types.js";

export type SymphonyHttpScope = "pod" | "agent";

export type SymphonyHttpRequest = {
  scope: SymphonyHttpScope;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  expectStream?: boolean;
};

export type SymphonyHttpEnv = {
  podUrl: string;
  agentUrl: string;
};

export type RetryOptions = {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
};

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  initialBackoffMs: 250,
  maxBackoffMs: 4_000,
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class SymphonyHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly url: string;

  constructor(params: { status: number; statusText: string; bodyText: string; url: string }) {
    super(
      `Symphony HTTP ${params.status} ${params.statusText} (${params.url}): ${params.bodyText.slice(0, 500)}`,
    );
    this.name = "SymphonyHttpError";
    this.status = params.status;
    this.statusText = params.statusText;
    this.bodyText = params.bodyText;
    this.url = params.url;
  }
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const trimmedBase = base.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${normalizedPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

function authHeaders(tokens: SymphonyTokens, scope: SymphonyHttpScope): Record<string, string> {
  const sessionToken = tokens.sessionToken;
  if (scope === "pod") {
    return { sessionToken };
  }
  return { sessionToken, keyManagerToken: tokens.keyManagerToken };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function symphonyFetch<T>(params: {
  env: SymphonyHttpEnv;
  tokens: SymphonyTokens;
  request: SymphonyHttpRequest;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  retry?: Partial<RetryOptions>;
  refreshTokens?: () => Promise<SymphonyTokens>;
}): Promise<T> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const userAgent = params.userAgent ?? "openclaw-symphony-plugin/0.1.0";
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...params.retry };
  const base = params.request.scope === "pod" ? params.env.podUrl : params.env.agentUrl;
  const url = buildUrl(base, params.request.path, params.request.query);

  let tokens = params.tokens;
  let attempt = 0;
  let backoff = retry.initialBackoffMs;

  while (true) {
    attempt += 1;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": userAgent,
      ...authHeaders(tokens, params.request.scope),
    };

    let body: string | FormData | undefined;
    if (params.request.formData) {
      body = params.request.formData;
    } else if (params.request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params.request.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: params.request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(params.request.signal ? { signal: params.request.signal } : {}),
      });
    } catch (error) {
      if (attempt < retry.maxAttempts) {
        await sleep(backoff, params.request.signal);
        backoff = Math.min(backoff * 2, retry.maxBackoffMs);
        continue;
      }
      throw error;
    }

    if (response.status === 401 && params.refreshTokens && attempt === 1) {
      tokens = await params.refreshTokens();
      continue;
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < retry.maxAttempts) {
      await sleep(backoff, params.request.signal);
      backoff = Math.min(backoff * 2, retry.maxBackoffMs);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SymphonyHttpError({
        status: response.status,
        statusText: response.statusText,
        bodyText: text,
        url,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (params.request.expectStream || contentType.includes("application/octet-stream")) {
      return (await response.arrayBuffer()) as unknown as T;
    }
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
