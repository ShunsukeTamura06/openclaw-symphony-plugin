import { isAccountConfigured } from "./config.js";
import type { SymphonyAccountConfig } from "./types.js";

export const symphonySetupAdapter = {
  describeAccount(account: SymphonyAccountConfig | undefined) {
    return {
      configured: isAccountConfigured(account),
      summary: account
        ? `Symphony bot ${account.username} @ ${account.podUrl}`
        : "Symphony account not configured",
    };
  },
  validateAccount(account: SymphonyAccountConfig | undefined): string[] {
    const issues: string[] = [];
    if (!account) {
      issues.push("No Symphony account configured (channels.symphony.accounts.<id>).");
      return issues;
    }
    if (!account.podUrl) issues.push("podUrl is required");
    if (!account.agentUrl) issues.push("agentUrl is required");
    if (!account.username) issues.push("username is required");
    if (!account.privateKeyPath) issues.push("privateKeyPath is required");
    return issues;
  },
} as const;

export const symphonySetupWizard = {
  id: "symphony",
  title: "Symphony",
  steps: [
    {
      id: "pod-url",
      kind: "text",
      label: "Pod URL",
      placeholder: "https://acme.symphony.com",
      help: "Symphony Pod base URL.",
      required: true,
      configPath: "channels.symphony.podUrl",
    },
    {
      id: "agent-url",
      kind: "text",
      label: "Agent URL",
      placeholder: "https://acme-agent.symphony.com",
      help: "Symphony Agent base URL.",
      required: true,
      configPath: "channels.symphony.agentUrl",
    },
    {
      id: "username",
      kind: "text",
      label: "Bot username",
      help: "Service-account username registered in Symphony admin portal.",
      required: true,
      configPath: "channels.symphony.username",
    },
    {
      id: "private-key-path",
      kind: "text",
      label: "Private key path",
      placeholder: "/absolute/path/to/bot-private.pem",
      help: "Absolute path to the RSA private key whose public key was uploaded for the bot.",
      required: true,
      configPath: "channels.symphony.privateKeyPath",
      sensitive: false,
    },
    {
      id: "relay-url",
      kind: "text",
      label: "Relay URL (optional)",
      placeholder: "Leave blank to reuse Pod URL",
      configPath: "channels.symphony.relayUrl",
      required: false,
    },
  ],
} as const;
