import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describeSymphonyAccount, symphonySetupAdapter } from "../src/setup.js";

function emptyCfg(): OpenClawConfig {
  return {} as OpenClawConfig;
}

describe("symphonySetupAdapter.applyAccountConfig", () => {
  it("creates the symphony.accounts.<id> path when nothing exists", () => {
    const cfg = emptyCfg();
    const next = symphonySetupAdapter.applyAccountConfig({
      cfg,
      accountId: "prod",
      input: {
        httpUrl: "https://acme.symphony.com",
        baseUrl: "https://acme-agent.symphony.com",
        userId: "openclaw-bot",
        tokenFile: "/etc/secrets/bot.pem",
      },
    });

    const account = (next as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
      .channels?.symphony?.accounts?.prod;
    expect(account).toEqual({
      podUrl: "https://acme.symphony.com",
      agentUrl: "https://acme-agent.symphony.com",
      username: "openclaw-bot",
      privateKeyPath: "/etc/secrets/bot.pem",
    });
  });

  it("does not mutate the original cfg (structuredClone)", () => {
    const cfg = emptyCfg();
    symphonySetupAdapter.applyAccountConfig({
      cfg,
      accountId: "prod",
      input: { httpUrl: "https://x" },
    });
    expect(cfg).toEqual({});
  });

  it("merges into an existing account without dropping unrelated fields", () => {
    const cfg = {
      channels: {
        symphony: {
          accounts: {
            prod: {
              podUrl: "https://old.example.com",
              agentUrl: "https://old-agent.example.com",
              username: "bot",
              privateKeyPath: "/old.pem",
              enabled: true,
              datafeedTag: "tag-keep",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = symphonySetupAdapter.applyAccountConfig({
      cfg,
      accountId: "prod",
      input: { httpUrl: "https://new.example.com" },
    });

    const merged = (next as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>)
      .channels?.symphony?.accounts?.prod;
    expect(merged).toEqual({
      podUrl: "https://new.example.com", // overwritten
      agentUrl: "https://old-agent.example.com", // preserved
      username: "bot", // preserved
      privateKeyPath: "/old.pem", // preserved
      enabled: true, // preserved
      datafeedTag: "tag-keep", // preserved
    });
  });

  it("creates a separate account entry without touching siblings", () => {
    const cfg = {
      channels: {
        symphony: {
          accounts: {
            prod: { podUrl: "https://prod", username: "p", privateKeyPath: "/p" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = symphonySetupAdapter.applyAccountConfig({
      cfg,
      accountId: "qa",
      input: { httpUrl: "https://qa", userId: "q", tokenFile: "/q.pem" },
    });

    const accounts = (next as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
      .channels?.symphony?.accounts;
    expect(Object.keys(accounts ?? {}).sort()).toEqual(["prod", "qa"]);
    expect(accounts?.prod).toEqual({ podUrl: "https://prod", username: "p", privateKeyPath: "/p" });
  });

  it("only writes fields that the input bag actually provides", () => {
    const cfg = {
      channels: {
        symphony: {
          accounts: {
            prod: { podUrl: "https://p", username: "u", privateKeyPath: "/k" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const next = symphonySetupAdapter.applyAccountConfig({
      cfg,
      accountId: "prod",
      input: { tokenFile: "/new-key.pem" },
    });

    const acct = (next as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
      .channels?.symphony?.accounts?.prod;
    expect(acct).toEqual({
      podUrl: "https://p", // unchanged
      username: "u", // unchanged
      privateKeyPath: "/new-key.pem", // updated
    });
  });
});

describe("symphonySetupAdapter.validateInput", () => {
  it("accepts a valid PEM-shaped privateKey", () => {
    expect(
      symphonySetupAdapter.validateInput?.({
        cfg: emptyCfg(),
        accountId: "prod",
        input: { privateKey: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" },
      }),
    ).toBeNull();
  });

  it("rejects a privateKey that is not PEM-shaped", () => {
    const result = symphonySetupAdapter.validateInput?.({
      cfg: emptyCfg(),
      accountId: "prod",
      input: { privateKey: "not-a-pem-blob" },
    });
    expect(result).toMatch(/PEM-encoded RSA private key/u);
  });

  it("returns null when no privateKey is supplied (path-based setup is the norm)", () => {
    expect(
      symphonySetupAdapter.validateInput?.({
        cfg: emptyCfg(),
        accountId: "prod",
        input: { tokenFile: "/etc/secrets/bot.pem" },
      }),
    ).toBeNull();
  });
});

describe("describeSymphonyAccount", () => {
  it("describes a fully configured account", () => {
    expect(
      describeSymphonyAccount({
        podUrl: "https://acme.symphony.com",
        agentUrl: "https://acme-agent.symphony.com",
        username: "openclaw-bot",
        privateKeyPath: "/k.pem",
      }),
    ).toEqual({
      configured: true,
      summary: "Symphony bot openclaw-bot @ https://acme.symphony.com",
    });
  });

  it("flags an unconfigured account", () => {
    expect(describeSymphonyAccount(undefined)).toEqual({
      configured: false,
      summary: "Symphony account not configured",
    });
  });
});
