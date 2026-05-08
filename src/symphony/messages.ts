import type { SymphonyHttpRequest } from "./http.js";
import type { SendMessageInput, SymphonyAttachmentInput, SymphonyMessage } from "./types.js";

export type SendMessageResponse = SymphonyMessage;

export function sendMessage(input: SendMessageInput): SymphonyHttpRequest {
  const formData = new FormData();
  formData.append("message", input.messageMl);
  if (input.data !== undefined) {
    formData.append("data", typeof input.data === "string" ? input.data : JSON.stringify(input.data));
  }
  if (input.version) {
    formData.append("version", input.version);
  }
  for (const attachment of input.attachments ?? []) {
    formData.append("attachment", toBlob(attachment), attachment.filename);
  }
  return {
    scope: "agent",
    method: "POST",
    path: `/agent/v4/stream/${encodeURIComponent(input.streamId)}/message/create`,
    formData,
  };
}

export function getAttachment(params: {
  streamId: string;
  messageId: string;
  fileId: string;
}): SymphonyHttpRequest {
  return {
    scope: "agent",
    method: "GET",
    path: `/agent/v1/stream/${encodeURIComponent(params.streamId)}/attachment`,
    query: { messageId: params.messageId, fileId: params.fileId },
    expectStream: true,
  };
}

export function getMessage(messageId: string): SymphonyHttpRequest {
  return {
    scope: "agent",
    method: "GET",
    path: `/agent/v1/message/${encodeURIComponent(messageId)}`,
  };
}

export function getMessagesByStream(params: {
  streamId: string;
  since: number;
  skip?: number;
  limit?: number;
}): SymphonyHttpRequest {
  return {
    scope: "agent",
    method: "GET",
    path: `/agent/v4/stream/${encodeURIComponent(params.streamId)}/message`,
    query: {
      since: params.since,
      ...(params.skip !== undefined ? { skip: params.skip } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    },
  };
}

function toBlob(attachment: SymphonyAttachmentInput): Blob {
  if (attachment.content instanceof Blob) {
    return attachment.content;
  }
  return new Blob([attachment.content], {
    type: attachment.contentType ?? "application/octet-stream",
  });
}
