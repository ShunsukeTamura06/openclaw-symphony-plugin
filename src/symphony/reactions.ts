import type { SymphonyHttpRequest } from "./http.js";

/**
 * Symphony emoji reaction API.
 *
 * Endpoints (pod scope — sessionToken only, no keyManagerToken):
 *   POST /pod/v1/message/{messageId}/reactions/add
 *   POST /pod/v1/message/{messageId}/reactions/remove
 *
 * Request body: { reaction: "<shortcode>" }
 *
 * The plugin uses these for best-effort "OpenClaw is processing your
 * message" feedback (hourglass on receive, removed on completion). All
 * call sites should treat reaction failures as non-fatal and only log.
 */

export const addReaction = (params: {
  messageId: string;
  reaction: string;
}): SymphonyHttpRequest => ({
  scope: "pod",
  method: "POST",
  path: `/pod/v1/message/${encodeURIComponent(params.messageId)}/reactions/add`,
  body: { reaction: params.reaction },
});

export const removeReaction = (params: {
  messageId: string;
  reaction: string;
}): SymphonyHttpRequest => ({
  scope: "pod",
  method: "POST",
  path: `/pod/v1/message/${encodeURIComponent(params.messageId)}/reactions/remove`,
  body: { reaction: params.reaction },
});
