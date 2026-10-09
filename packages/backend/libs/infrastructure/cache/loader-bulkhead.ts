import { CacheLoaderBusy } from './cache.errors';

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/**
 * Per-instance cap on concurrently running loaders (FR-026): the (N+1)th caller waits in arrival order for up to
 * `waitMs`, then is rejected with `CacheLoaderBusy`. Protects the source of truth while the cache is down.
 * Empty when idle.
 */
export class LoaderBulkhead {
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly waitMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats(): { running: number; queued: number } {
    return { running: this.running, queued: this.queue.length };
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(
            new CacheLoaderBusy(Math.max(1, Math.ceil(this.waitMs / 1000))),
          );
        }, this.waitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next)
      next.grant(); // the slot passes straight to the longest waiter
    else this.running--;
  }
}
