import { messageMlToPlain } from "./messageml.js";
import type { DatafeedEventEnvelope, SymphonyMessage } from "./symphony/types.js";

export type NormalizedAttachment = {
  id: string;
  filename: string;
  size: number;
  contentType?: string;
};

export type NormalizedInboundMessage = {
  channelId: "symphony";
  accountId: string;
  messageId: string;
  timestamp: number;
  streamId: string;
  streamType: string;
  isDirect: boolean;
  text: string;
  rawMessageMl?: string;
  data?: string;
  sender: {
    id: string;
    displayName?: string;
    email?: string;
    username?: string;
  };
  mentions: Array<{ userId?: number; email?: string }>;
  emojis: string[];
  attachments: NormalizedAttachment[];
};

export function normalizeInboundMessage(params: {
  message: SymphonyMessage;
  accountId: string;
  selfUserId?: number;
}): NormalizedInboundMessage | null {
  if (!params.message || !params.message.messageId) {
    return null;
  }
  if (params.selfUserId && params.message.user.id === params.selfUserId) {
    return null;
  }
  const parsed = messageMlToPlain(params.message.message ?? "");
  const sender = {
    id: String(params.message.user.id),
    ...(params.message.user.displayName ? { displayName: params.message.user.displayName } : {}),
    ...(params.message.user.emailAddress ? { email: params.message.user.emailAddress } : {}),
    ...(params.message.user.username ? { username: params.message.user.username } : {}),
  };
  const attachments = (params.message.attachments ?? []).map((a) => ({
    id: a.id,
    filename: a.name,
    size: a.size,
    ...(a.contentType ? { contentType: a.contentType } : {}),
  }));

  return {
    channelId: "symphony",
    accountId: params.accountId,
    messageId: params.message.messageId,
    timestamp: params.message.timestamp,
    streamId: params.message.stream.id,
    streamType: params.message.stream.streamType,
    isDirect: params.message.stream.streamType === "IM",
    text: parsed.text,
    ...(params.message.message ? { rawMessageMl: params.message.message } : {}),
    ...(params.message.data ? { data: params.message.data } : {}),
    sender,
    mentions: parsed.mentions,
    emojis: parsed.emojis,
    attachments,
  };
}

export function extractMessageFromEvent(
  envelope: DatafeedEventEnvelope,
): SymphonyMessage | null {
  if (envelope.type !== "MESSAGESENT") {
    return null;
  }
  const messageSent = (envelope.payload as { messageSent?: { message?: SymphonyMessage } })
    .messageSent;
  return messageSent?.message ?? null;
}
