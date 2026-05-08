import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateBot, createBotJwt, tokensExpired } from "../src/symphony/auth.js";

function makeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function decodeBase64Url(input: string): Buffer {
  const padded = input.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

describe("createBotJwt", () => {
  it("produces a JWT with correct header/payload and verifiable RS512 signature", () => {
    const { privateKeyPem, publicKeyPem } = makeKeyPair();
    const now = 1_700_000_000_000;
    const { jwt, expiresAt } = createBotJwt({
      username: "bot.user",
      privateKeyPem,
      ttlSec: 290,
      now,
    });

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = JSON.parse(decodeBase64Url(headerB64).toString("utf8"));
    expect(header).toEqual({ alg: "RS512", typ: "JWT" });

    const payload = JSON.parse(decodeBase64Url(payloadB64).toString("utf8"));
    expect(payload.sub).toBe("bot.user");
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect(payload.exp).toBe(Math.floor(now / 1000) + 290);
    expect(expiresAt).toBe((Math.floor(now / 1000) + 290) * 1000);

    const verifier = createVerify("RSA-SHA512");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const valid = verifier.verify(createPublicKey(publicKeyPem), decodeBase64Url(signatureB64));
    expect(valid).toBe(true);
  });
});

describe("tokensExpired", () => {
  it("returns true when the expiry is within the safety margin", () => {
    expect(tokensExpired({ sessionToken: "s", keyManagerToken: "k", issuedAt: 0, expiresAt: Date.now() + 5_000 })).toBe(true);
  });
  it("returns false when there's plenty of time left", () => {
    expect(tokensExpired({ sessionToken: "s", keyManagerToken: "k", issuedAt: 0, expiresAt: Date.now() + 120_000 })).toBe(false);
  });
});

describe("authenticateBot", () => {
  it("calls pod and relay endpoints with the JWT and returns combined tokens", async () => {
    const { privateKeyPem } = makeKeyPair();
    const calls: Array<{ url: string; body: unknown }> = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body });
      const isPod = url.includes("/login/pubkey");
      return new Response(JSON.stringify({ token: isPod ? "session-XYZ" : "km-ABC" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const tokens = await authenticateBot({
      env: { podUrl: "https://pod.example.com/", agentUrl: "https://agent.example.com" },
      credentials: { username: "bot", privateKeyPem },
      fetchImpl: fakeFetch,
    });

    expect(tokens.sessionToken).toBe("session-XYZ");
    expect(tokens.keyManagerToken).toBe("km-ABC");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toMatch(/\/login\/pubkey\/authenticate$/u);
    expect(calls[1]?.url).toMatch(/\/relay\/pubkey\/authenticate$/u);
    expect(typeof (calls[0]?.body as { token: string }).token).toBe("string");
  });
});
