export interface BackoffLimits {
  baseMs: number;
  capMs: number;
}

/** Full jitter: a uniform delay in `[0, min(cap, base x 2^attempt)]`. `random` is injected (0 <= r < 1). */
export function fullJitterMs(
  attempt: number,
  random: () => number,
  limits: BackoffLimits,
): number {
  const exponent = Math.min(Math.max(0, attempt), 40);
  const bound = Math.min(limits.capMs, limits.baseMs * 2 ** exponent);
  return Math.max(0, Math.floor(random() * bound));
}

/** Delay before the next lookup of an `UNKNOWN` payment (the first lookup is a fixed delay, not computed here). */
export const unknownDelayMs = fullJitterMs;

/** Delay before the next charge attempt after a "not sent" answer. */
export const chargeRetryDelayMs = fullJitterMs;

/** The cut-off of the charge retry: at most `maxAttempts` attempts, and none after the deadline from creation. */
export function chargeRetryAllowed(input: {
  attempts: number;
  createdAt: Date;
  now: Date;
  maxAttempts: number;
  deadlineSeconds: number;
}): boolean {
  if (input.attempts >= input.maxAttempts) return false;
  return (
    input.now.getTime() - input.createdAt.getTime() <
    input.deadlineSeconds * 1000
  );
}
