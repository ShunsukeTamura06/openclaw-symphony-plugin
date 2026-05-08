import type { SymphonyClient } from "./client.js";
import { SymphonyHttpError } from "./http.js";
import type { Datafeed, DatafeedEventEnvelope } from "./types.js";

export type DatafeedLoopHandlers = {
  onEvent: (event: DatafeedEventEnvelope) => void | Promise<void>;
  onError?: (error: unknown) => void;
  onLog?: (msg: string) => void;
};

export type DatafeedLoopOptions = {
  client: SymphonyClient;
  tag?: string;
  signal?: AbortSignal;
  handlers: DatafeedLoopHandlers;
  recreateBackoffMs?: number;
};

const DEFAULT_RECREATE_BACKOFF = 5_000;

export async function runDatafeedLoop(options: DatafeedLoopOptions): Promise<void> {
  const log = options.handlers.onLog ?? (() => undefined);
  const onError = options.handlers.onError ?? (() => undefined);
  const recreateBackoffMs = options.recreateBackoffMs ?? DEFAULT_RECREATE_BACKOFF;

  let datafeed: Datafeed | null = await resolveDatafeed(options.client, options.tag);
  log(`datafeed ready id=${datafeed.id}`);

  let ackId = "";

  while (!options.signal?.aborted) {
    try {
      const result = await options.client.readDatafeed({
        datafeedId: datafeed.id,
        ackId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      ackId = result.ackId;

      for (const event of result.events ?? []) {
        if (options.signal?.aborted) {
          return;
        }
        try {
          await options.handlers.onEvent(event);
        } catch (eventError) {
          onError(eventError);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      if (isAbortError(error)) {
        return;
      }
      if (error instanceof SymphonyHttpError && (error.status === 400 || error.status === 404)) {
        log(`datafeed gone (${error.status}); recreating`);
        try {
          datafeed = await options.client.createDatafeed(options.tag);
          ackId = "";
          continue;
        } catch (recreateError) {
          onError(recreateError);
          await delay(recreateBackoffMs, options.signal);
          continue;
        }
      }
      onError(error);
      await delay(recreateBackoffMs, options.signal);
    }
  }
}

async function resolveDatafeed(client: SymphonyClient, tag: string | undefined): Promise<Datafeed> {
  const existing = await client.listDatafeeds(tag).catch(() => [] as Datafeed[]);
  if (existing.length > 0 && existing[0]) {
    return existing[0];
  }
  return await client.createDatafeed(tag);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  return name === "AbortError";
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
