/** Rejects with `onTimeout()` when `call` does not settle within `ms`; the timer never outlives the call. */
export async function withTimeout<T>(
  call: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
