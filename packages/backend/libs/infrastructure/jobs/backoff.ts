import { fullJitterBackoff } from '@app/common/core/backoff';

const BASE_MS = 1_000;
const MAX_MS = 15 * 60_000;

/** Upper bound of the retry delay after `attempts` failed runs: `min(15 min, 1 s × 2^attempts)`. */
export function retryCeilingMs(attempts: number): number {
  return Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempts));
}

/** Full-jitter delay in `0..retryCeilingMs(attempts)`; `random` is a parameter so tests are deterministic. */
export function retryDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  return fullJitterBackoff(
    attempts,
    { baseMs: BASE_MS, maxMs: MAX_MS },
    random,
  );
}
