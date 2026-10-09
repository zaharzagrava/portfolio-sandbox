/**
 * Polls `probe` until it returns a truthy value or the timeout elapses.
 * For asynchronous pipelines (outbox → Kafka → projector → read model)
 * where the spec must wait for eventual consistency instead of sleeping.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, description = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor(${description}) timed out after ${timeoutMs}ms${lastError ? `: ${(lastError as Error).message}` : ''}`,
  );
}

/**
 * Fires `n` calls concurrently (released together on the same tick) and
 * returns all settled results - the core of the "exactly one winner"
 * contention specs (seat holds, bids, stock, idempotency).
 */
export async function inParallel<T>(
  n: number,
  fn: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = Array.from({ length: n }, async (_, i) => {
    await gate;
    return fn(i);
  });
  release();
  return Promise.allSettled(calls);
}

/** Counts HTTP statuses from supertest responses settled by `inParallel`. */
export function countStatuses(
  results: PromiseSettledResult<{ status: number }>[],
): Record<number, number> {
  return results.reduce<Record<number, number>>((acc, r) => {
    const status = r.status === 'fulfilled' ? r.value.status : -1;
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}
