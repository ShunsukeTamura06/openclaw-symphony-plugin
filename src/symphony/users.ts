import type { SymphonyHttpRequest } from "./http.js";
import type { SymphonyUser } from "./types.js";

export const getUserById = (uid: number, local = false): SymphonyHttpRequest => ({
  scope: "pod",
  method: "GET",
  path: "/pod/v3/users",
  query: { uid: String(uid), local: local ? "true" : "false" },
});

export const getUserByEmail = (email: string, local = false): SymphonyHttpRequest => ({
  scope: "pod",
  method: "GET",
  path: "/pod/v3/users",
  query: { email, local: local ? "true" : "false" },
});

export const getUserByUsername = (username: string): SymphonyHttpRequest => ({
  scope: "pod",
  method: "GET",
  path: "/pod/v3/users",
  query: { username },
});

export const getSessionUser = (): SymphonyHttpRequest => ({
  scope: "pod",
  method: "GET",
  path: "/pod/v2/sessioninfo",
});

export type UsersListResponse = { users: SymphonyUser[] };
export type SessionInfoResponse = SymphonyUser & { roles?: string[] };
