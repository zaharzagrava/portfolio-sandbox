import { Domain_OverloadedError } from './errors';

/**
 * Semaphore with a bounded queue for password hashing (A12, A13). Argon2 runs on the libuv pool; unbounded callers
 * would starve every other user of the pool (file system, DNS), so the work is capped and the overflow is shed
 * with a `503 overloaded` instead of queuing without limit.
 */
export class BoundedConcurrency {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit = 4,
    private readonly maxQueue = 64,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxQueue)
        throw new Domain_OverloadedError();
      // The releaser hands its slot over directly, so `running` never dips below the work in flight.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

const LIBUV_DEFAULT_POOL = 4;

/**
 * Startup rule: hashing may use at most `UV_THREADPOOL_SIZE - 1` threads, leaving one for everything else. An unset
 * variable means libuv's default of 4, which a production process may not rely on.
 */
export function hashConcurrencyProblems(
  limit: number,
  poolSize: number | undefined,
  production: boolean,
): string[] {
  if (poolSize === undefined && !production) return [];
  const pool = poolSize ?? LIBUV_DEFAULT_POOL;
  return limit > pool - 1
    ? [
        `auth hash concurrency (${limit}) must not exceed UV_THREADPOOL_SIZE - 1 (UV_THREADPOOL_SIZE=${poolSize ?? 'unset, libuv default 4'})`,
      ]
    : [];
}
