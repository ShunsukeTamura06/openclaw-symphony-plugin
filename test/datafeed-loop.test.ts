import { describe, expect, it, vi } from "vitest";
import { runDatafeedLoop } from "../src/symphony/datafeed-loop.js";
import { SymphonyHttpError } from "../src/symphony/http.js";
import type { SymphonyClient } from "../src/symphony/client.js";
import type { Datafeed, DatafeedEventEnvelope } from "../src/symphony/types.js";

function makeFakeClient(overrides: Partial<SymphonyClient>): SymphonyClient {
  return {
    listDatafeeds: vi.fn(async () => [] as Datafeed[]),
    createDatafeed: vi.fn(async () => ({ id: "df-1" })),
    deleteDatafeed: vi.fn(async () => undefined),
    readDatafeed: vi.fn(async () => ({ ackId: "", events: [] })),
    ...overrides,
  } as unknown as SymphonyClient;
}

describe("runDatafeedLoop", () => {
  it("creates a datafeed, dispatches events, and stops when aborted", async () => {
    const events: DatafeedEventEnvelope[] = [
      { id: "e1", type: "MESSAGESENT", timestamp: 1, payload: {} },
      { id: "e2", type: "ROOM_CREATED", timestamp: 2, payload: {} },
    ];
    let calls = 0;
    const controller = new AbortController();
    const client = makeFakeClient({
      readDatafeed: vi.fn(async ({ ackId }) => {
        calls += 1;
        if (calls === 1) {
          return { ackId: "ack-1", events };
        }
        controller.abort();
        return { ackId, events: [] };
      }),
    });

    const seen: string[] = [];
    await runDatafeedLoop({
      client,
      signal: controller.signal,
      handlers: {
        onEvent: (envelope) => {
          seen.push(envelope.type);
        },
      },
    });

    expect(seen).toEqual(["MESSAGESENT", "ROOM_CREATED"]);
    expect(client.createDatafeed).toHaveBeenCalledTimes(1);
  });

  it("recreates the datafeed on 400/404 from read", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const create = vi.fn(async () => ({ id: "df-new" }) as Datafeed);
    const client = makeFakeClient({
      listDatafeeds: vi.fn(async () => [{ id: "df-old" } as Datafeed]),
      createDatafeed: create,
      readDatafeed: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new SymphonyHttpError({
            status: 400,
            statusText: "Bad",
            bodyText: "{}",
            url: "https://x/y",
          });
        }
        controller.abort();
        return { ackId: "", events: [] };
      }),
    });

    await runDatafeedLoop({
      client,
      signal: controller.signal,
      recreateBackoffMs: 1,
      handlers: { onEvent: () => undefined },
    });

    expect(create).toHaveBeenCalledTimes(1);
  });
});
