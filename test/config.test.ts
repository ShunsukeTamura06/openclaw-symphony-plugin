import { describe, expect, it } from "vitest";
import {
  getAccountConfig,
  isAccountConfigured,
  listAccountIds,
  resolveDefaultAccountId,
} from "../src/config.js";

const inlineCfg = {
  channels: {
    symphony: {
      podUrl: "https://pod.example.com",
      agentUrl: "https://agent.example.com",
      username: "bot",
      privateKeyPath: "/keys/bot.pem",
      enabled: true,
    },
  },
};

const namedAccountsCfg = {
  channels: {
    symphony: {
      defaultAccount: "qa",
      accounts: {
        prod: {
          podUrl: "https://prod.example.com",
          agentUrl: "https://prod-agent.example.com",
          username: "bot-prod",
          privateKeyPath: "/keys/prod.pem",
        },
        qa: {
          podUrl: "https://qa.example.com",
          agentUrl: "https://qa-agent.example.com",
          username: "bot-qa",
          privateKeyPath: "/keys/qa.pem",
          enabled: false,
        },
      },
    },
  },
};

describe("resolveDefaultAccountId", () => {
  it("returns explicit defaultAccount when set", () => {
    expect(resolveDefaultAccountId(namedAccountsCfg)).toBe("qa");
  });

  it("falls back to the first account key when no defaultAccount is set", () => {
    const cfg = {
      channels: { symphony: { accounts: { alpha: {}, beta: {} } } },
    };
    expect(resolveDefaultAccountId(cfg)).toBe("alpha");
  });

  it("returns 'default' when no accounts block or inline is present", () => {
    expect(resolveDefaultAccountId(undefined)).toBe("default");
    expect(resolveDefaultAccountId({})).toBe("default");
    expect(resolveDefaultAccountId({ channels: {} })).toBe("default");
  });
});

describe("listAccountIds", () => {
  it("lists accounts when accounts block is present", () => {
    expect(listAccountIds(namedAccountsCfg).sort()).toEqual(["prod", "qa"]);
  });

  it("returns ['default'] for inline account fields", () => {
    expect(listAccountIds(inlineCfg)).toEqual(["default"]);
  });

  it("returns empty when no symphony block exists", () => {
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds({ channels: {} })).toEqual([]);
    expect(listAccountIds(undefined)).toEqual([]);
  });

  it("ignores accounts block when it has no entries", () => {
    expect(listAccountIds({ channels: { symphony: { accounts: {} } } })).toEqual([]);
  });
});

describe("getAccountConfig", () => {
  it("resolves a named account from the accounts map", () => {
    const account = getAccountConfig(namedAccountsCfg, "prod");
    expect(account?.podUrl).toBe("https://prod.example.com");
    expect(account?.username).toBe("bot-prod");
  });

  it("respects the per-account enabled flag", () => {
    expect(getAccountConfig(namedAccountsCfg, "qa")?.enabled).toBe(false);
  });

  it("uses defaultAccount when accountId is null", () => {
    expect(getAccountConfig(namedAccountsCfg, null)?.username).toBe("bot-qa");
  });

  it("resolves inline account fields under the synthetic 'default' id", () => {
    const account = getAccountConfig(inlineCfg, "default");
    expect(account?.podUrl).toBe("https://pod.example.com");
    expect(account?.username).toBe("bot");
  });

  it("falls back agentUrl to podUrl when agentUrl is missing on inline form", () => {
    const cfg = {
      channels: {
        symphony: {
          podUrl: "https://only-pod.example.com",
          username: "bot",
          privateKeyPath: "/k.pem",
        },
      },
    };
    const account = getAccountConfig(cfg, "default");
    expect(account?.podUrl).toBe("https://only-pod.example.com");
    expect(account?.agentUrl).toBe("https://only-pod.example.com");
  });

  it("does not mistake inline fields for a non-default accountId", () => {
    expect(getAccountConfig(inlineCfg, "prod")).toBeUndefined();
  });

  // Regression: getAccountConfig used to silently drop allowedUsers /
  // allowedRooms / denyDmsByDefault from the inline form, which made the
  // gateway treat the whitelist as empty even when it was configured.
  it("propagates allowedUsers from inline config (regression: was silently dropped)", () => {
    const cfg = {
      channels: {
        symphony: {
          podUrl: "https://pod.example.com",
          agentUrl: "https://agent.example.com",
          username: "bot",
          privateKeyPath: "/k.pem",
          allowedUsers: ["alice@example.com", "12345"],
        },
      },
    };
    expect(getAccountConfig(cfg, "default")?.allowedUsers).toEqual([
      "alice@example.com",
      "12345",
    ]);
  });

  it("propagates allowedRooms from inline config", () => {
    const cfg = {
      channels: {
        symphony: {
          podUrl: "https://pod.example.com",
          username: "bot",
          privateKeyPath: "/k.pem",
          allowedRooms: ["room-A", "room-B"],
        },
      },
    };
    expect(getAccountConfig(cfg, "default")?.allowedRooms).toEqual(["room-A", "room-B"]);
  });

  it("propagates denyDmsByDefault from inline config", () => {
    const cfg = {
      channels: {
        symphony: {
          podUrl: "https://pod.example.com",
          username: "bot",
          privateKeyPath: "/k.pem",
          denyDmsByDefault: false,
        },
      },
    };
    expect(getAccountConfig(cfg, "default")?.denyDmsByDefault).toBe(false);
  });

  it("ignores malformed allowedUsers (not an array of strings)", () => {
    const cfg = {
      channels: {
        symphony: {
          podUrl: "https://pod.example.com",
          username: "bot",
          privateKeyPath: "/k.pem",
          allowedUsers: "alice", // wrong shape
        },
      },
    };
    expect(getAccountConfig(cfg, "default")?.allowedUsers).toBeUndefined();
  });

  it("returns undefined when neither accounts nor inline fields are present", () => {
    expect(getAccountConfig({}, "anything")).toBeUndefined();
    expect(getAccountConfig({ channels: { symphony: {} } }, "default")).toBeUndefined();
  });
});

describe("isAccountConfigured", () => {
  it("requires all four mandatory fields", () => {
    expect(
      isAccountConfigured({
        podUrl: "https://p",
        agentUrl: "https://a",
        username: "u",
        privateKeyPath: "/k",
      }),
    ).toBe(true);
  });

  it.each([
    { missing: "podUrl" },
    { missing: "agentUrl" },
    { missing: "username" },
    { missing: "privateKeyPath" },
  ])("returns false when $missing is empty", ({ missing }) => {
    const base = {
      podUrl: "https://p",
      agentUrl: "https://a",
      username: "u",
      privateKeyPath: "/k",
    };
    const incomplete = { ...base, [missing]: "" };
    expect(isAccountConfigured(incomplete)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAccountConfigured(undefined)).toBe(false);
  });
});
