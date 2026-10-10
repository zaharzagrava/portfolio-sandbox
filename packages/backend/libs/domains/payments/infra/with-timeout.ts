/**
 * Rejects with `onTimeout()` when `promise` has not settled after `ms`. The underlying call is not cancelled (the
 * clients used here take no abort signal); its late result is dropped. The timer is always cleared.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
