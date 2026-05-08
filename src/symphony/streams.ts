import type { SymphonyHttpRequest } from "./http.js";
import type { CreateImInput, SymphonyStream } from "./types.js";

export const createIm = (input: CreateImInput): SymphonyHttpRequest => ({
  scope: "pod",
  method: "POST",
  path: "/pod/v1/im/create",
  body: input.userIds,
});

export const getStreamInfo = (streamId: string): SymphonyHttpRequest => ({
  scope: "pod",
  method: "GET",
  path: `/pod/v2/streams/${encodeURIComponent(streamId)}/info`,
});

export const listUserStreams = (params: {
  skip?: number;
  limit?: number;
  filter?: { streamTypes?: string[]; includeInactiveStreams?: boolean };
}): SymphonyHttpRequest => ({
  scope: "pod",
  method: "POST",
  path: "/pod/v1/streams/list",
  query: {
    ...(params.skip !== undefined ? { skip: params.skip } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  },
  body: params.filter ?? {},
});

export const createRoom = (params: {
  name: string;
  description: string;
  membersCanInvite?: boolean;
  discoverable?: boolean;
  public?: boolean;
  readOnly?: boolean;
  copyProtected?: boolean;
  crossPod?: boolean;
  viewHistory?: boolean;
  multiLateralRoom?: boolean;
  keywords?: Array<{ key: string; value: string }>;
}): SymphonyHttpRequest => ({
  scope: "pod",
  method: "POST",
  path: "/pod/v3/room/create",
  body: params,
});

export type StreamInfoResponse = SymphonyStream & {
  attributes?: Record<string, unknown>;
  roomAttributes?: Record<string, unknown>;
};
