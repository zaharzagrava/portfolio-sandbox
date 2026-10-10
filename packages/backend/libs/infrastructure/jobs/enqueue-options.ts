import { InvalidEnqueueOptionsError } from './job-errors';
import type { EnqueueOptions } from './job-types';

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_KEY_LENGTH = 200;
export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 25;
export const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_RUN_AHEAD_MS = 366 * 86_400_000;

/** Same rule for a job's own `maxAttempts` and a schedule's. */
export function isValidAttempts(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ATTEMPTS &&
    value <= MAX_ATTEMPTS
  );
}

/** Throws `InvalidEnqueueOptionsError{field}` for the first limit that is broken; `now` is a parameter (no wall clock). */
export function validateEnqueueOptions(
  options: EnqueueOptions,
  payload: unknown,
  now: Date,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES)
    throw new InvalidEnqueueOptionsError(
      'payload',
      `${bytes} bytes serialised, limit ${MAX_PAYLOAD_BYTES}`,
    );

  const { idempotencyKey, maxAttempts, runAt } = options;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > MAX_KEY_LENGTH)
  )
    throw new InvalidEnqueueOptionsError(
      'idempotencyKey',
      `1 to ${MAX_KEY_LENGTH} characters`,
    );

  if (maxAttempts !== undefined && !isValidAttempts(maxAttempts))
    throw new InvalidEnqueueOptionsError(
      'maxAttempts',
      `integer ${MIN_ATTEMPTS} to ${MAX_ATTEMPTS}`,
    );

  if (runAt !== undefined) {
    if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime()))
      throw new InvalidEnqueueOptionsError('runAt', 'not a valid date');
    if (runAt.getTime() > now.getTime() + MAX_RUN_AHEAD_MS)
      throw new InvalidEnqueueOptionsError(
        'runAt',
        'more than 366 days in the future',
      );
  }
}

/** Order: the caller's option, the schedule's, the type's default, then 8. */
export function resolveMaxAttempts(sources: {
  option?: number;
  schedule?: number | null;
  typeDefault?: number;
}): number {
  return (
    sources.option ??
    sources.schedule ??
    sources.typeDefault ??
    DEFAULT_MAX_ATTEMPTS
  );
}
