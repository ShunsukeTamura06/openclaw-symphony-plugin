import { createPrivateKey, createSign } from "node:crypto";
import type { SymphonyCredentials, SymphonyEnvironment, SymphonyTokens } from "./types.js";

const DEFAULT_JWT_TTL_SEC = 290;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

export function createBotJwt(params: {
  username: string;
  privateKeyPem: string;
  ttlSec?: number;
  now?: number;
}): { jwt: string; expiresAt: number } {
  const ttlSec = params.ttlSec ?? DEFAULT_JWT_TTL_SEC;
  const issuedAt = Math.floor((params.now ?? Date.now()) / 1000);
  const expiresAt = issuedAt + ttlSec;

  const header = { alg: "RS512", typ: "JWT" };
  const payload = { sub: params.username, iat: issuedAt, exp: expiresAt };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;

  const key = createPrivateKey({ key: params.privateKeyPem, format: "pem" });
  const signer = createSign("RSA-SHA512");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);

  return {
    jwt: `${signingInput}.${base64UrlEncode(signature)}`,
    expiresAt: expiresAt * 1000,
  };
}

type AuthenticateResponse = { token?: string; name?: string };

async function exchangeJwtForToken(params: {
  url: string;
  jwt: string;
  fetchImpl: typeof fetch;
  userAgent: string;
}): Promise<string> {
  const response = await params.fetchImpl(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": params.userAgent,
    },
    body: JSON.stringify({ token: params.jwt }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Symphony pubkey authenticate failed (${response.status} ${response.statusText}) at ${params.url}: ${text.slice(0, 500)}`,
    );
  }

  let parsed: AuthenticateResponse;
  try {
    parsed = JSON.parse(text) as AuthenticateResponse;
  } catch {
    throw new Error(`Symphony authenticate returned non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!parsed.token) {
    throw new Error(`Symphony authenticate missing 'token' in response: ${text.slice(0, 200)}`);
  }
  return parsed.token;
}

export async function authenticateBot(params: {
  env: SymphonyEnvironment;
  credentials: SymphonyCredentials;
  jwtTtlSec?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}): Promise<SymphonyTokens> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const userAgent = params.userAgent ?? "openclaw-symphony-plugin/0.1.0";

  const { jwt, expiresAt } = createBotJwt({
    username: params.credentials.username,
    privateKeyPem: params.credentials.privateKeyPem,
    ttlSec: params.jwtTtlSec,
  });

  const podBase = stripTrailingSlash(params.env.podUrl);
  const relayBase = stripTrailingSlash(params.env.relayUrl ?? params.env.podUrl);

  const sessionTokenUrl = `${podBase}/login/pubkey/authenticate`;
  const kmTokenUrl = `${relayBase}/relay/pubkey/authenticate`;

  const [sessionToken, keyManagerToken] = await Promise.all([
    exchangeJwtForToken({ url: sessionTokenUrl, jwt, fetchImpl, userAgent }),
    exchangeJwtForToken({ url: kmTokenUrl, jwt, fetchImpl, userAgent }),
  ]);

  return {
    sessionToken,
    keyManagerToken,
    issuedAt: Date.now(),
    expiresAt,
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function tokensExpired(tokens: SymphonyTokens, marginMs = 30_000): boolean {
  return Date.now() + marginMs >= tokens.expiresAt;
}
