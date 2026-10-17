import { StoreUnavailableError } from '../domain/draft-ports';

/**
 * Bounds how long a caller waits for a store (S06 FR-038): the call is abandoned after `ms` and reported as
 * `StoreUnavailableError`. The underlying request may still finish; the caller never waits for it.
 */
export async function withTimeout<T>(
  operation: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StoreUnavailableError(`${operation} timed out`)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), deadline]);
  } catch (error) {
    if (error instanceof StoreUnavailableError) throw error;
    throw new StoreUnavailableError(operation, error);
  } finally {
    clearTimeout(timer);
  }
}

/** Same, for a caller that treats a failure as "not available" and carries on (best effort calls). */
export async function bestEffort<T>(
  operation: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await withTimeout(operation, ms, fn);
  } catch {
    return undefined;
  }
}
