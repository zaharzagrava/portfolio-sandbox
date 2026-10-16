/** A call that took longer than its timeout. */
export class DependencyTimeoutError extends Error {}

/**
 * Every outbound call has an explicit timeout (S27 FR-064): the work is abandoned (not cancelled) after `timeoutMs` and
 * the caller gets a `DependencyTimeoutError`.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DependencyTimeoutError('timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
