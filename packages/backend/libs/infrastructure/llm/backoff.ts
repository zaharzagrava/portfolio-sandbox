import { BackoffOptions, fullJitterBackoff } from '@app/common/core/backoff';

export type { BackoffOptions };

export const DEFAULT_RETRY_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 8_000,
};

/** A 429 without `Retry-After` still puts the model on cooldown for this long. */
export const DEFAULT_COOLDOWN_MS = 5_000;

/**
 * How long to wait before retry number `attempt` (0-based): the provider's `Retry-After` exactly when it sent one,
 * otherwise exponential backoff with full jitter in [0, min(maxMs, baseMs * 2^attempt)) (AS-50).
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  options: BackoffOptions = DEFAULT_RETRY_BACKOFF,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs))
    return Math.max(0, Math.ceil(retryAfterMs));
  return fullJitterBackoff(attempt, options, random);
}
