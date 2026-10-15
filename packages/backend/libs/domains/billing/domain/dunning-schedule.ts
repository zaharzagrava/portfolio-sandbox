import { DAY_MS } from './periods';

/**
 * Dunning (S17 FR-034): attempts 2, 3 and 4 are due 1, 3 and 7 days after the FIRST failure, whenever the previous
 * attempt actually ran. Fixed, not configurable. A pure function of `firstFailedAt` and the attempt that just failed.
 */
export const DUNNING_OFFSET_DAYS = [1, 3, 7] as const;
export const MAX_ATTEMPTS = DUNNING_OFFSET_DAYS.length + 1;

/** When the attempt after `failedAttempt` (1-based) is due; `null` after the last numbered attempt. */
export function nextAttemptAt(
  firstFailedAt: Date,
  failedAttempt: number,
): Date | null {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1)
    throw new Error('attempt numbers start at 1');
  const days = DUNNING_OFFSET_DAYS[failedAttempt - 1];
  return days === undefined
    ? null
    : new Date(firstFailedAt.getTime() + days * DAY_MS);
}
