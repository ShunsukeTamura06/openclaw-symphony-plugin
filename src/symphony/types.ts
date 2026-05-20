export type SymphonyEnvironment = {
  podUrl: string;
  agentUrl: string;
  relayUrl?: string;
};

export type SymphonyCredentials = {
  username: string;
  privateKeyPem: string;
};

export type SymphonyTokens = {
  sessionToken: string;
  keyManagerToken: string;
  issuedAt: number;
  expiresAt: number;
};

export type SymphonyClientOptions = {
  env: SymphonyEnvironment;
  credentials: SymphonyCredentials;
  jwtTtlSec?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

export type SymphonyUser = {
  id?: number;
  userId?: number;
  emailAddress?: string;
  email?: string;
  displayName?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  accountType?: string;
};

export type SymphonyStream = {
  id?: string;
  streamId?: string;
  streamType: SymphonyStreamType | { type: SymphonyStreamType };
  crossPod?: boolean;
  origin?: string;
  active?: boolean;
};

export type SymphonyStreamType =
  | "IM"
  | "MIM"
  | "ROOM"
  | "POST"
  | "ELEVATED_ROOM"
  | "WALL_POST"
  | string;

export type SymphonyAttachmentInfo = {
  id: string;
  name: string;
  size: number;
  contentType?: string;
  images?: Array<{ id: string; dimension: string }>;
};

export type SymphonyMessage = {
  messageId: string;
  timestamp: number;
  message?: string;
  data?: string;
  user: SymphonyUser;
  stream: SymphonyStream;
  attachments?: SymphonyAttachmentInfo[];
  sharedMessage?: SymphonyMessage;
  replacing?: string;
  replacedBy?: string;
  initialTimestamp?: number;
  initialMessageId?: string;
  silent?: boolean;
};

export type DatafeedEvent =
  | { type: "MESSAGESENT"; payload: { messageSent: { message: SymphonyMessage } } }
  | { type: "INSTANT_MESSAGE_CREATED"; payload: Record<string, unknown> }
  | { type: "ROOM_CREATED"; payload: Record<string, unknown> }
  | { type: "USER_JOINED_ROOM"; payload: Record<string, unknown> }
  | { type: "USER_LEFT_ROOM"; payload: Record<string, unknown> }
  | { type: "ROOM_MEMBER_PROMOTED_TO_OWNER"; payload: Record<string, unknown> }
  | { type: "ROOM_MEMBER_DEMOTED_FROM_OWNER"; payload: Record<string, unknown> }
  | { type: "MESSAGE_SUPPRESSED"; payload: Record<string, unknown> }
  | { type: "SHARED_POST"; payload: Record<string, unknown> }
  | { type: "SYMPHONY_ELEMENTS_ACTION"; payload: Record<string, unknown> }
  | { type: "CONNECTION_REQUESTED" | "CONNECTION_ACCEPTED"; payload: Record<string, unknown> }
  | { type: string; payload: Record<string, unknown> };

export type DatafeedEventEnvelope = {
  id: string;
  messageId?: string;
  timestamp: number;
  type: string;
  initiator?: { user?: SymphonyUser };
  payload: Record<string, unknown>;
};

export type Datafeed = {
  id: string;
  createdAt?: number;
  tag?: string;
};

export type SymphonyError = {
  code?: number;
  message: string;
  status?: number;
  raw?: unknown;
};

export type SendMessageInput = {
  streamId: string;
  messageMl: string;
  data?: string | Record<string, unknown>;
  attachments?: SymphonyAttachmentInput[];
  version?: string;
};

export type SymphonyAttachmentInput = {
  filename: string;
  content: Uint8Array | Blob;
  contentType?: string;
};

export type CreateImInput = {
  userIds: number[];
};
