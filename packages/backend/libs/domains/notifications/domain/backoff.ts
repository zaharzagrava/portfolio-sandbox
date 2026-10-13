/** Retry schedule of a delivery line (FR-031): exponential from 30 s, capped at 15 minutes, at most 5 attempts. */
export const BACKOFF_BASE_S = 30;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_CAP_S = 900;
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Seconds to wait before attempt `attempt + 1` after attempt `attempt` failed: full jitter, uniform in
 * `[0, min(cap, base * factor^(attempt - 1))]`. `random` returns a number in `[0, 1)`; it is injected so the rule is
 * deterministic under a seed.
 */
export function backoffSeconds(attempt: number, random: () => number): number {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  const ceiling = Math.min(
    BACKOFF_CAP_S,
    BACKOFF_BASE_S * BACKOFF_FACTOR ** (attempt - 1),
  );
  return random() * ceiling;
}
