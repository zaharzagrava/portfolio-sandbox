/**
 * Maps `items` through `fn` with at most `concurrency` promises in flight.
 * `Promise.all(items.map(fn))` on 10k items opens 10k sockets / DB queries at
 * once; this keeps fan-out bounded while preserving result order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) throw new RangeError('concurrency must be >= 1');

  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );

  return results;
}

/** Like `mapWithConcurrency` but never rejects - for partial-response aggregation. */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, concurrency, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await fn(item, index) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
}
