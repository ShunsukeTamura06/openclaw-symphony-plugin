import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  getAccountConfig,
  isAccountConfigured,
  listAccountIds,
  resolveDefaultAccountId,
} from "./config.js";
import { SymphonyChannelConfigSchema } from "./config-schema.js";
import { symphonyGatewayAdapter } from "./gateway.js";
import { symphonyMessageAdapter, symphonyOutboundAdapter } from "./outbound.js";
import { symphonySetupAdapter } from "./setup.js";
import { describeSymphonyAccountSnapshot, symphonyStatusAdapter } from "./status.js";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  type ResolvedSymphonyAccount,
  type SymphonyAccountProbe,
} from "./types.js";

export const symphonyPlugin = createChatChannelPlugin<ResolvedSymphonyAccount, SymphonyAccountProbe>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Symphony",
      selectionLabel: "Symphony (Bot)",
      docsPath: "/channels/symphony",
      blurb: "Symphony Messaging via REST API + Datafeed v5 (RSA-JWT bot auth).",
      aliases: ["symphony-chat"],
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    setup: symphonySetupAdapter,
    messaging: {
      targetPrefixes: ["symphony"],
      normalizeTarget: (target: string): string | undefined => {
        const trimmed = target.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.replace(/^symphony:(?:stream:|im:|room:)?/iu, "");
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim() ?? "";
          if (!trimmed) {
            return false;
          }
          if (/^symphony:/iu.test(trimmed)) {
            return true;
          }
          // Symphony stream IDs are URL-safe base64 (~27 chars) — accept anything
          // that looks like a long opaque token to give the resolver a chance.
          return /^[A-Za-z0-9_-]{20,}={0,2}$/u.test(trimmed);
        },
        hint: "<streamId|symphony:streamId>",
      },
    },
    configSchema: buildChannelConfigSchema(SymphonyChannelConfigSchema),
    config: {
      listAccountIds: (cfg: OpenClawConfig) =>
        listAccountIds(cfg as unknown as Record<string, unknown>),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedSymphonyAccount => {
        const id = accountId ?? resolveDefaultAccountId(cfg as unknown as Record<string, unknown>);
        const account = getAccountConfig(cfg as unknown as Record<string, unknown>, id);
        if (!account) {
          return {
            accountId: id,
            podUrl: "",
            agentUrl: "",
            username: "",
            privateKeyPath: "",
            enabled: false,
          };
        }
        return { accountId: id, ...account };
      },
      defaultAccountId: (cfg: OpenClawConfig) =>
        resolveDefaultAccountId(cfg as unknown as Record<string, unknown>),
      isConfigured: (account: ResolvedSymphonyAccount) => isAccountConfigured(account),
      isEnabled: (account: ResolvedSymphonyAccount) => account.enabled !== false,
      describeAccount: (account: ResolvedSymphonyAccount) =>
        describeSymphonyAccountSnapshot(account),
    },
    status: symphonyStatusAdapter,
    gateway: symphonyGatewayAdapter,
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### Symphony channel output",
        "Symphony renders MessageML (XML), not Markdown. The channel auto-converts common Markdown",
        "(headings, **bold**, *italic*, `code`, fenced code blocks, lists, links, blockquote,",
        "horizontal rules, GFM tables) to MessageML, so writing plain Markdown is fine.",
        "",
        "**Symphony-only features** (no Markdown equivalent — write these as MessageML directly):",
        "- Mention a user: `<mention email=\"alice@example.com\"/>` or `<mention uid=\"12345\"/>`",
        "- Emoji shortcode: `<emoji shortcode=\"smile\"/>`",
        "- Interactive form (presents clickable choices to the user): a fenced block tagged",
        "  `symphony-form` with a JSON body. ui_type can be `buttons`, `radio`, or `select`.",
        "",
        "Form example:",
        "```symphony-form",
        '{"form_id":"choice","question":"続行しますか？","ui_type":"buttons","choices":[{"id":"yes","label":"はい","class":"primary"},{"id":"no","label":"いいえ"}]}',
        "```",
        "Use forms when offering 2–4 discrete choices the user might want to click.",
        "Inline images are NOT rendered — the alt text is shown instead. Prefer attaching files",
        "or linking via `[label](url)` when the user needs to see something visual.",
      ],
    },
  },
  pairing: {
    idLabel: "symphonyUserId",
    normalizeAllowEntry: createPairingPrefixStripper(/^symphony:(?:user:)?/iu),
  },
  outbound: symphonyOutboundAdapter,
});

export const SYMPHONY_DEFAULT_ACCOUNT_ID = DEFAULT_ACCOUNT_ID;
