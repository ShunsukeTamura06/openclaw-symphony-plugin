/**
 * Per-stream serial inbound job queue.
 *
 * Datafeed v5 long-poll must not block on AI response time. We accept jobs
 * synchronously, serialize them per `accountId:streamId` chain so a single
 * conversation's reply order is preserved, and run different streams in
 * parallel.
 *
 * Failures are isolated: a thrown error in one job is reported via `onError`
 * but does not break the chain or leak as an unhandled rejection.
 */
export type InboundJob = {
  accountId: string;
  streamId: string;
  messageId: string;
  run: () => Promise<void>;
};

export type InboundQueueOptions = {
  /** Called when a job throws. Defaults to console.error. */
  onError?: (error: unknown, job: InboundJob) => void;
};

export class InboundQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly onError: (error: unknown, job: InboundJob) => void;

  constructor(options: InboundQueueOptions = {}) {
    this.onError =
      options.onError ??
      ((err, job) =>
        console.error(
          `[symphony] inbound job ${job.accountId}/${job.streamId}/${job.messageId} failed:`,
          err,
        ));
  }

  /**
   * Enqueue a job for sequential processing within its stream.
   * Returns immediately (does NOT wait for the job to complete).
   */
  enqueue(job: InboundJob): void {
    const key = chainKey(job);
    const previous = this.chains.get(key) ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await job.run();
        } catch (err) {
          this.onError(err, job);
        }
      })
      .finally(() => {
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      });

    this.chains.set(key, next);
  }

  /**
   * Wait until every currently enqueued job (and anything chained after them
   * at the time of call) has settled. Primarily used for graceful shutdown
   * and tests.
   */
  async drain(): Promise<void> {
    while (this.chains.size > 0) {
      const snapshot = Array.from(this.chains.values());
      await Promise.allSettled(snapshot);
    }
  }

  /** Number of streams with an active chain. */
  activeChains(): number {
    return this.chains.size;
  }
}

function chainKey(job: InboundJob): string {
  return `${job.accountId}:${job.streamId}`;
}
