import { getAccountConfig, resolveDefaultAccountId } from "./config.js";
import {
  plainToMessageMl,
  textWithSymphonyFormToMessageMl,
  type MentionDirective,
} from "./messageml.js";
import { getOrCreateClient, getSymphonyRuntime } from "./runtime.js";
import type { SymphonyAttachmentInput } from "./symphony/types.js";
import { CHANNEL_ID } from "./types.js";

type Cfg = Record<string, unknown> | undefined;

type SendTextContext = {
  cfg: Cfg;
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string | null;
  mediaReadFile?: (path: string) => Promise<Buffer>;
};

type DeliveryResult = {
  channel: typeof CHANNEL_ID;
  messageId: string;
  chatId?: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
};

export type SendOptions = {
  text?: string;
  messageMl?: string;
  data?: string | Record<string, unknown>;
  mentions?: MentionDirective[];
  emojis?: string[];
  attachments?: SymphonyAttachmentInput[];
};

export async function sendSymphonyMessage(params: {
  cfg: Cfg;
  accountId?: string | null;
  streamId: string;
  options: SendOptions;
}): Promise<DeliveryResult> {
  const accountId = params.accountId ?? resolveDefaultAccountId(params.cfg);
  const account = getAccountConfig(params.cfg, accountId);
  if (!account) {
    throw new Error(`Symphony account "${accountId}" is not configured`);
  }
  const client = getOrCreateClient(accountId, account);

  const messageMl =
    params.options.messageMl ??
    plainToMessageMl({
      text: params.options.text ?? "",
      ...(params.options.mentions ? { mentions: params.options.mentions } : {}),
      ...(params.options.emojis ? { emojis: params.options.emojis } : {}),
    });

  const response = await client.sendMessage({
    streamId: params.streamId,
    messageMl,
    ...(params.options.data !== undefined ? { data: params.options.data } : {}),
    ...(params.options.attachments && params.options.attachments.length > 0
      ? { attachments: params.options.attachments }
      : {}),
  });

  return {
    channel: CHANNEL_ID,
    messageId: response.messageId,
    chatId: params.streamId,
    timestamp: response.timestamp,
  };
}

function stripSymphonyPrefix(input: string): string {
  return input.replace(/^symphony:(?:stream:|im:|room:)?/iu, "");
}

async function loadAttachmentFromMediaUrl(
  mediaUrl: string,
  mediaReadFile?: (path: string) => Promise<Buffer>,
): Promise<SymphonyAttachmentInput | undefined> {
  if (!mediaUrl) {
    return undefined;
  }
  if (mediaUrl.startsWith("data:")) {
    const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/u.exec(mediaUrl);
    if (!match) {
      return undefined;
    }
    const mediaType = match[1] ?? "application/octet-stream";
    const payload = match[2] ?? "";
    const isBase64 = mediaUrl.includes(";base64,");
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { filename: deriveFilename(mediaType), content: new Uint8Array(bytes), contentType: mediaType };
  }
  if (mediaUrl.startsWith("file://") || mediaUrl.startsWith("/")) {
    if (!mediaReadFile) {
      return undefined;
    }
    const path = mediaUrl.startsWith("file://") ? mediaUrl.slice("file://".length) : mediaUrl;
    const buf = await mediaReadFile(path);
    return { filename: path.split("/").pop() ?? "attachment", content: new Uint8Array(buf) };
  }
  return undefined;
}

function deriveFilename(mediaType: string): string {
  const ext = mediaType.split("/")[1]?.split(";")[0] ?? "bin";
  return `attachment.${ext}`;
}

export const symphonyOutboundAdapter = {
  deliveryMode: "direct" as const,
  chunkerMode: "markdown" as const,
  textChunkLimit: 30_000,
  presentationCapabilities: {
    supported: false,
  },
  async sendText(ctx: SendTextContext): Promise<DeliveryResult> {
    const log = getSymphonyRuntime();
    const streamId = stripSymphonyPrefix(ctx.to ?? "");
    if (!streamId) {
      throw new Error(`Symphony outbound: empty target (to=${ctx.to})`);
    }
    const accountId = ctx.accountId ?? null;
    const attachment = ctx.mediaUrl
      ? await loadAttachmentFromMediaUrl(ctx.mediaUrl, ctx.mediaReadFile)
      : undefined;
    try {
      // Convert AI-emitted Markdown to MessageML before sending. This is the
      // non-reply outbound path (the gateway delivery callback does the same
      // conversion); without it, `####`, `**bold**`, lists etc. would appear
      // verbatim in Symphony. Also detects ```symphony-form``` blocks and
      // converts them to native Symphony Element forms.
      const messageMl = textWithSymphonyFormToMessageMl(ctx.text ?? "");
      return await sendSymphonyMessage({
        cfg: ctx.cfg,
        accountId,
        streamId,
        options: {
          messageMl,
          ...(attachment ? { attachments: [attachment] } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Symphony sendText failed: ${message}`);
      throw error;
    }
  },
};

export const symphonyMessageAdapter = {
  formatTarget(streamId: string): string {
    return `symphony:${streamId}`;
  },
  parseTarget(input: string): { streamId: string } {
    return { streamId: stripSymphonyPrefix(input) };
  },
};
