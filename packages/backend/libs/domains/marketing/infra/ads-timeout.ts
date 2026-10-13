import { AdsDependencyUnavailableError } from '../domain/ads-ports';

/** Races `work` against a timer; a late answer is dropped. Failure or timeout is `AdsDependencyUnavailableError` (FR-072). */
export async function withDeadline<T>(
  dependency: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${dependency} timeout`)),
          ms,
        );
      }),
    ]);
  } catch (error) {
    throw new AdsDependencyUnavailableError(dependency, error);
  } finally {
    clearTimeout(timer);
  }
}
