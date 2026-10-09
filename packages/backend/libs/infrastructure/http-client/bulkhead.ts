import { HttpClientError } from './http-client-error';

export interface BulkheadOptions {
  /** Calls running at once. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot; one more fails at once. */
  maxQueue: number;
  /** How long a queued call waits for a slot before it fails. */
  queueWaitMs: number;
}

export const DEFAULT_BULKHEAD: BulkheadOptions = {
  maxConcurrent: 64,
  maxQueue: 64,
  queueWaitMs: 100,
};

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/**
 * Per-dependency concurrency limit with a bounded wait queue (FR-058): one slow third party can hold at most
 * `maxConcurrent` sockets and `maxQueue` waiting callers; everything beyond that fails at once with `bulkhead_full`.
 */
export class Bulkhead {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: BulkheadOptions) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.options.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueue)
      return Promise.reject(
        new HttpClientError('bulkhead_full', {
          attempts: 0,
          retryAfterMs: 1_000,
        }),
      );
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(waiter), 1);
          reject(
            new HttpClientError('bulkhead_full', {
              attempts: 0,
              retryAfterMs: 1_000,
            }),
          );
        }, this.options.queueWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(); // the slot passes straight to the waiter
    } else {
      this.running--;
    }
  }
}
