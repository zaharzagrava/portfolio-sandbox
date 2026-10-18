/**
 * Back-off for recreating a live connection that was closed for good (W05 FR-042, AS-28): 1, 2, 4, 8, 16 seconds and then
 * every 30 seconds, each delay randomised by +-20 percent so a crowd of tabs does not return in the same second. The counter
 * starts again after a connection that stayed open for `STABLE_CONNECTION_MS`.
 */
export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export const STABLE_CONNECTION_MS = 30_000;
const JITTER = 0.2;

/** The delay before attempt number `attempt` (0 is the first). `random` returns [0, 1]; it is a parameter so tests can pin it. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_STEPS_MS[Math.min(Math.max(attempt, 0), BACKOFF_STEPS_MS.length - 1)]!;
  return base * (1 - JITTER + 2 * JITTER * random());
}
