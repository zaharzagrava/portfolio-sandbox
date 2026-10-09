export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/**
 * "Full jitter" exponential backoff (AWS Architecture Blog): a uniformly random
 * delay in [0, min(max, base * 2^attempt)]. Spreads synchronized retries from
 * many clients instead of having them hammer a recovering dependency in waves.
 */
export function fullJitterBackoff(
  attempt: number,
  { baseMs, maxMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    // The abort reason is passed through exactly as given (usually an AbortError / TimeoutError DOMException).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
      },
      { once: true },
    );
  });
