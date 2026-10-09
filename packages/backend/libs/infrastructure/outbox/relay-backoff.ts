import { BackoffOptions, fullJitterBackoff } from '@app/common/core/backoff';

/** Relay retry window (FR-016): full jitter between 0 and min(60 s, 1 s x 2^attempts). */
export const RELAY_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/**
 * Delay before the next publish attempt, given the number of failed attempts so far (>= 1).
 * `random` is injectable so tests script the jitter.
 */
export const relayBackoffMs = (
  failedAttempts: number,
  random: () => number = Math.random,
): number => fullJitterBackoff(failedAttempts, RELAY_BACKOFF, random);
