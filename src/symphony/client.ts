import { authenticateBot, tokensExpired } from "./auth.js";
import {
  createDatafeed,
  deleteDatafeed,
  listDatafeeds,
  readDatafeed,
  type DatafeedListResponse,
  type ReadDatafeedResponse,
} from "./datafeed.js";
import { symphonyFetch, type SymphonyHttpRequest } from "./http.js";
import {
  getAttachment,
  getMessage,
  getMessagesByStream,
  sendMessage,
  type SendMessageResponse,
} from "./messages.js";
import { addReaction, removeReaction } from "./reactions.js";
import {
  createIm,
  createRoom,
  getStreamInfo,
  listUserStreams,
  type StreamInfoResponse,
} from "./streams.js";
import type {
  CreateImInput,
  Datafeed,
  SendMessageInput,
  SymphonyClientOptions,
  SymphonyMessage,
  SymphonyStream,
  SymphonyTokens,
  SymphonyUser,
} from "./types.js";
import {
  getSessionUser,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  type SessionInfoResponse,
  type UsersListResponse,
} from "./users.js";

export class SymphonyClient {
  private readonly options: SymphonyClientOptions;
  private tokens: SymphonyTokens | null = null;
  private refreshing: Promise<SymphonyTokens> | null = null;

  constructor(options: SymphonyClientOptions) {
    this.options = options;
  }

  async ensureTokens(): Promise<SymphonyTokens> {
    if (this.tokens && !tokensExpired(this.tokens)) {
      return this.tokens;
    }
    return await this.refreshTokens();
  }

  private async refreshTokens(): Promise<SymphonyTokens> {
    if (this.refreshing) {
      return await this.refreshing;
    }
    this.refreshing = (async () => {
      const tokens = await authenticateBot({
        env: this.options.env,
        credentials: this.options.credentials,
        ...(this.options.jwtTtlSec !== undefined ? { jwtTtlSec: this.options.jwtTtlSec } : {}),
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      });
      this.tokens = tokens;
      return tokens;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async request<T>(req: SymphonyHttpRequest): Promise<T> {
    const tokens = await this.ensureTokens();
    return await symphonyFetch<T>({
      env: this.options.env,
      tokens,
      request: req,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      refreshTokens: () => this.refreshTokens(),
    });
  }

  async sessionInfo(): Promise<SessionInfoResponse> {
    return await this.request<SessionInfoResponse>(getSessionUser());
  }

  async getUserById(id: number): Promise<SymphonyUser | undefined> {
    const res = await this.request<UsersListResponse>(getUserById(id));
    return res.users[0];
  }

  async getUserByEmail(email: string): Promise<SymphonyUser | undefined> {
    const res = await this.request<UsersListResponse>(getUserByEmail(email));
    return res.users[0];
  }

  async getUserByUsername(username: string): Promise<SymphonyUser | undefined> {
    const res = await this.request<UsersListResponse>(getUserByUsername(username));
    return res.users[0];
  }

  async createIm(input: CreateImInput): Promise<SymphonyStream> {
    return await this.request<SymphonyStream>(createIm(input));
  }

  async createRoom(params: Parameters<typeof createRoom>[0]): Promise<unknown> {
    return await this.request<unknown>(createRoom(params));
  }

  async getStreamInfo(streamId: string): Promise<StreamInfoResponse> {
    return await this.request<StreamInfoResponse>(getStreamInfo(streamId));
  }

  async listUserStreams(params: Parameters<typeof listUserStreams>[0] = {}): Promise<SymphonyStream[]> {
    return await this.request<SymphonyStream[]>(listUserStreams(params));
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResponse> {
    return await this.request<SendMessageResponse>(sendMessage(input));
  }

  async getMessage(messageId: string): Promise<SymphonyMessage> {
    return await this.request<SymphonyMessage>(getMessage(messageId));
  }

  async getMessagesByStream(params: Parameters<typeof getMessagesByStream>[0]): Promise<SymphonyMessage[]> {
    return await this.request<SymphonyMessage[]>(getMessagesByStream(params));
  }

  async getAttachmentBytes(params: Parameters<typeof getAttachment>[0]): Promise<ArrayBuffer> {
    return await this.request<ArrayBuffer>(getAttachment(params));
  }

  async createDatafeed(tag?: string): Promise<Datafeed> {
    return await this.request<Datafeed>(createDatafeed(tag));
  }

  async listDatafeeds(tag?: string): Promise<DatafeedListResponse> {
    return await this.request<DatafeedListResponse>(listDatafeeds(tag));
  }

  async readDatafeed(params: Parameters<typeof readDatafeed>[0]): Promise<ReadDatafeedResponse> {
    return await this.request<ReadDatafeedResponse>(readDatafeed(params));
  }

  async deleteDatafeed(datafeedId: string): Promise<void> {
    await this.request<void>(deleteDatafeed(datafeedId));
  }

  async addReaction(params: { messageId: string; reaction: string }): Promise<void> {
    await this.request<unknown>(addReaction(params));
  }

  async removeReaction(params: { messageId: string; reaction: string }): Promise<void> {
    await this.request<unknown>(removeReaction(params));
  }
}
