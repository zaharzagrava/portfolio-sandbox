/** Errors of the enqueue-side API (contracts/jobs-service.md). None carries a payload value. */

export class UnknownJobTypeError extends Error {
  constructor(readonly type: string) {
    super(`unknown job type "${type}": no declareJobType() call for it`);
    this.name = 'UnknownJobTypeError';
  }
}

export class InvalidJobPayloadError extends Error {
  constructor(
    readonly type: string,
    /** Dotted paths of the offending fields. */
    readonly fields: string[],
  ) {
    super(`invalid payload for "${type}": ${fields.join(', ') || '(root)'}`);
    this.name = 'InvalidJobPayloadError';
  }
}

export class InvalidEnqueueOptionsError extends Error {
  constructor(
    readonly field: 'payload' | 'idempotencyKey' | 'maxAttempts' | 'runAt',
    detail: string,
  ) {
    super(`invalid enqueue option ${field}: ${detail}`);
    this.name = 'InvalidEnqueueOptionsError';
  }
}

export class IdempotencyKeyConflictError extends Error {
  constructor(
    readonly key: string,
    readonly existingType: string,
  ) {
    super(
      `idempotency key "${key}" already belongs to a job of type "${existingType}"`,
    );
    this.name = 'IdempotencyKeyConflictError';
  }
}

export class InvalidScheduleError extends Error {
  constructor(
    readonly field:
      | 'name'
      | 'cron'
      | 'timezone'
      | 'maxAttempts'
      | 'overlap'
      | 'jobType'
      | 'payload',
    detail: string,
  ) {
    super(`invalid schedule ${field}: ${detail}`);
    this.name = 'InvalidScheduleError';
  }
}

/** A heartbeat found that this worker no longer holds the claim (lease expired and the job was taken over). */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`lease lost for job ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid list cursor');
    this.name = 'InvalidCursorError';
  }
}
