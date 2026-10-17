import { PermanentError, TransientError } from '../errors';

/** Another invocation holds a live claim on the key: the message retries later (transient). */
export class AlreadyInProgressError extends TransientError {
  constructor(key: string) {
    super(`${key} is being processed by another invocation`);
    this.name = 'AlreadyInProgressError';
  }
}

/** This attempt's lease was taken over: its completion or release changed nothing. */
export class StaleClaimError extends TransientError {
  constructor(key: string, options?: { cause?: unknown }) {
    super(
      `${key}: the claim of this attempt was taken over by another attempt`,
      options,
    );
    this.name = 'StaleClaimError';
  }
}

/** The same key arrived with a different fingerprint: a different payload, never a replay (permanent). */
export class IdempotencyKeyConflictError extends PermanentError {
  constructor(key: string) {
    super(`${key} was used before with a different fingerprint`);
    this.name = 'IdempotencyKeyConflictError';
  }
}

/** A key or an option is invalid; raised before any store call (permanent). */
export class InvalidIdempotencyKeyError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export class InvalidIdempotencyOptionsError extends PermanentError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyOptionsError';
  }
}
