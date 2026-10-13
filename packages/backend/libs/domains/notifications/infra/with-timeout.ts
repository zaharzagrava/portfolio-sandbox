/** Timeouts of the stores and edges (contracts/services.md): Redis 200 ms, wide-column 1 s, realtime 500 ms, directories 2 s. */
export const REDIS_TIMEOUT_MS = 200;
export const WIDE_COLUMN_TIMEOUT_MS = 1_000;
export const REALTIME_TIMEOUT_MS = 500;
export const DIRECTORY_TIMEOUT_MS = 2_000;

export class StoreTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'StoreTimeoutError';
  }
}

/**
 * Rejects with `StoreTimeoutError` when `promise` has not settled after `ms`. The underlying call is not cancelled
 * (the clients take no abort signal); its late result is dropped. The timer is always cleared.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StoreTimeoutError(what, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
