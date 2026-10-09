import type { Transaction } from 'sequelize';

export type Propagation = 'join' | 'requires_new';

export interface RunInTransactionOptions {
  isolationLevel?: Transaction.ISOLATION_LEVELS;
  /** Postgres-side guard against long lock waits blocking the pool (1..600 000 ms). */
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** `join` (default) reuses the active transaction; `requires_new` opens an independent one. */
  propagation?: Propagation;
  /** Serializable retry attempts, 1..3. */
  maxAttempts?: number;
}

export const MAX_TIMEOUT_MS = 600_000;
export const MAX_ATTEMPTS = 3;

export function validateTimeoutMs(name: string, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `${name} must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`,
    );
  }
  return value;
}

export function resolveTransactionOptions(
  options: RunInTransactionOptions,
): Required<Pick<RunInTransactionOptions, 'propagation' | 'maxAttempts'>> &
  RunInTransactionOptions {
  const propagation = options.propagation ?? 'join';
  if (propagation !== 'join' && propagation !== 'requires_new')
    throw new RangeError(`unknown propagation "${String(propagation)}"`);
  const maxAttempts = options.maxAttempts ?? 1;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS
  )
    throw new RangeError(
      `maxAttempts must be an integer between 1 and ${MAX_ATTEMPTS}`,
    );
  if (options.lockTimeoutMs !== undefined)
    validateTimeoutMs('lockTimeoutMs', options.lockTimeoutMs);
  if (options.statementTimeoutMs !== undefined)
    validateTimeoutMs('statementTimeoutMs', options.statementTimeoutMs);
  return { ...options, propagation, maxAttempts };
}
