/**
 * Waits of the payout flow (S15 FR-018, FR-019): full jitter, so many payouts that failed together do not return
 * together. Pure: the random source is a parameter.
 */
const MINUTE_MS = 60_000;
const RESOLVER_CAP_MS = 15 * MINUTE_MS;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * MINUTE_MS;

const clampCount = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** Wait before the next lookup after `unreachableCount` unreachable ones: ceiling 1, 2, 4 ... 15 minutes, jittered over [0, ceiling]. */
export function resolverDelayMs(
  unreachableCount: number,
  random: () => number,
): number {
  const ceiling = Math.min(
    RESOLVER_CAP_MS,
    MINUTE_MS * 2 ** Math.min(clampCount(unreachableCount), 20),
  );
  return Math.floor(random() * ceiling);
}

/** Wait before job attempt `attempt + 1` (attempt is 1-based): ceiling 5 s doubling to 5 min, jittered over [0, ceiling]. */
export function jobRetryDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(
    RETRY_CAP_MS,
    RETRY_BASE_MS * 2 ** Math.min(Math.max(clampCount(attempt) - 1, 0), 20),
  );
  return Math.floor(random() * ceiling);
}
