import { InvalidIdempotencyOptionsError } from './idempotency-errors';

export interface RunOptions {
  /** How long a claim holds. Positive, and at least the function timeout. */
  leaseMs: number;
  /** Digest of the payload; the same key with another fingerprint is a conflict. */
  fingerprint?: string;
  /** How long a completed record counts, in seconds (default 24 h). */
  retentionSec?: number;
}

export const DEFAULT_RETENTION_SEC = 24 * 3600;

/** Rejects, before any store call, a lease a second container could outlive (lease below the function timeout). */
export function assertValidOptions(
  options: RunOptions,
  functionTimeoutMs: number,
): void {
  const { leaseMs, retentionSec } = options;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new InvalidIdempotencyOptionsError(
      'lease must be a positive number of milliseconds',
    );
  if (leaseMs < functionTimeoutMs)
    throw new InvalidIdempotencyOptionsError(
      `lease ${leaseMs} ms is shorter than the function timeout ${functionTimeoutMs} ms`,
    );
  if (
    retentionSec !== undefined &&
    (!Number.isFinite(retentionSec) || retentionSec <= 0)
  )
    throw new InvalidIdempotencyOptionsError('retention must be positive');
}
