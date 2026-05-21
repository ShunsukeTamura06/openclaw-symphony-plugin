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
  const incomingUserId = params.message.user.userId ?? params.message.user.id;
  if (params.selfUserId !== undefined && incomingUserId === params.selfUserId) {
    return null;
  }
  const parsed = messageMlToPlain(params.message.message ?? "");
  const entityMentions = extractEntityMentions(params.message.data);
  const mentions = entityMentions.length > 0 ? entityMentions : parsed.mentions;
  const sender = {
    id: String(incomingUserId ?? ""),
    ...(params.message.user.displayName ? { displayName: params.message.user.displayName } : {}),
    ...(params.message.user.emailAddress ?? params.message.user.email
      ? { email: params.message.user.emailAddress ?? params.message.user.email }
      : {}),
    ...(params.message.user.username ? { username: params.message.user.username } : {}),
  };
  const attachments = (params.message.attachments ?? []).map((a) => ({
    id: a.id,
    filename: a.name,
    size: a.size,
    ...(a.contentType ? { contentType: a.contentType } : {}),
  }));

  const streamId = params.message.stream.streamId ?? params.message.stream.id ?? "";
  const streamTypeRaw = params.message.stream.streamType;
  const streamType =
    typeof streamTypeRaw === "object" && streamTypeRaw !== null
      ? (streamTypeRaw as { type: string }).type
      : String(streamTypeRaw ?? "");

  return {
    channelId: "symphony",
    accountId: params.accountId,
    messageId: params.message.messageId,
    timestamp: params.message.timestamp,
    streamId,
    streamType,
    isDirect: streamType === "IM",
    text: parsed.text,
    ...(params.message.message ? { rawMessageMl: params.message.message } : {}),
    ...(params.message.data ? { data: params.message.data } : {}),
    sender,
    mentions,
    emojis: parsed.emojis,
    attachments,
  };
}

// PresentationML v2 stores mentions in the message `data` JSON as:
// { "0": { "type": "com.symphony.user.mention", "id": [{ "type": "com.symphony.user.userId", "value": "12345" }] } }
function extractEntityMentions(data: string | undefined): Array<{ userId?: number; email?: string }> {
  if (!data) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return [];
  }
  const result: Array<{ userId?: number; email?: string }> = [];
  for (const entity of Object.values(parsed)) {
    if (!entity || typeof entity !== "object") continue;
    const e = entity as { type?: string; id?: Array<{ type?: string; value?: string }> };
    if (e.type !== "com.symphony.user.mention") continue;
    for (const idEntry of e.id ?? []) {
      if (!idEntry.value) continue;
      // Refs Q6 (docs/review-2026-05-20.md): Symphony entity JSON can
      // reference a mentioned user either by internal userId or — for
      // external users not yet onboarded with a userId in the pod — by
      // email address. Pick up both shapes.
      if (idEntry.type === "com.symphony.user.userId") {
        const uid = Number(idEntry.value);
        if (Number.isFinite(uid)) result.push({ userId: uid });
      } else if (idEntry.type === "com.symphony.user.emailAddress") {
        result.push({ email: idEntry.value });
      }
    }
  }
  return result;
}

// Handles SYMPHONYELEMENTSACTION events (Symphony Elements form submissions).
// User info lives in envelope.initiator.user; form data is in payload.symphonyElementsAction.
export function normalizeElementsAction(params: {
  envelope: DatafeedEventEnvelope;
  accountId: string;
  selfUserId?: number;
}): NormalizedInboundMessage | null {
  if (params.envelope.type !== "SYMPHONYELEMENTSACTION") return null;
  const action = (
    params.envelope.payload as { symphonyElementsAction?: unknown }
  ).symphonyElementsAction;
  if (!action || typeof action !== "object") return null;
  const a = action as {
    stream?: { streamId?: string; streamType?: unknown };
    formId?: string;
    formValues?: Record<string, unknown>;
    formMessageId?: string;
  };
  const streamId = a.stream?.streamId ?? "";
  if (!streamId || !a.formId || !a.formValues) return null;

  const user = params.envelope.initiator?.user;
  if (!user) return null;
  const userId = user.userId ?? user.id;
  if (params.selfUserId !== undefined && userId === params.selfUserId) return null;

  const streamTypeRaw = a.stream?.streamType;
  const streamType =
    typeof streamTypeRaw === "object" && streamTypeRaw !== null
      ? (streamTypeRaw as { type: string }).type
      : String(streamTypeRaw ?? "");

  const sender = {
    id: String(userId ?? ""),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.emailAddress ?? user.email
      ? { email: user.emailAddress ?? user.email }
      : {}),
    ...(user.username ? { username: user.username } : {}),
  };

  return {
    channelId: "symphony",
    accountId: params.accountId,
    messageId: params.envelope.id,
    timestamp: params.envelope.timestamp,
    streamId,
    streamType,
    isDirect: streamType === "IM",
    text: JSON.stringify(a.formValues),
    sender,
    mentions: [],
    emojis: [],
    attachments: [],
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
