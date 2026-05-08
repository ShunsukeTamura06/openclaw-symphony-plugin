import type { SymphonyHttpRequest } from "./http.js";
import type { Datafeed, DatafeedEventEnvelope } from "./types.js";

export const createDatafeed = (tag?: string): SymphonyHttpRequest => ({
  scope: "agent",
  method: "POST",
  path: "/agent/v5/datafeeds",
  body: tag ? { tag } : {},
});

export const listDatafeeds = (tag?: string): SymphonyHttpRequest => ({
  scope: "agent",
  method: "GET",
  path: "/agent/v5/datafeeds",
  ...(tag ? { query: { tag } } : {}),
});

export const deleteDatafeed = (datafeedId: string): SymphonyHttpRequest => ({
  scope: "agent",
  method: "DELETE",
  path: `/agent/v5/datafeeds/${encodeURIComponent(datafeedId)}`,
});

export const readDatafeed = (params: {
  datafeedId: string;
  ackId?: string;
  signal?: AbortSignal;
}): SymphonyHttpRequest => ({
  scope: "agent",
  method: "POST",
  path: `/agent/v5/datafeeds/${encodeURIComponent(params.datafeedId)}/read`,
  body: { ackId: params.ackId ?? "" },
  ...(params.signal ? { signal: params.signal } : {}),
});

export type ReadDatafeedResponse = {
  ackId: string;
  events: DatafeedEventEnvelope[];
};

export type DatafeedListResponse = Datafeed[];
