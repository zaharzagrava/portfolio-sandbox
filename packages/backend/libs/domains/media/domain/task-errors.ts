import type { PermanentFailureCode } from './video-errors';

/**
 * Why a task body failed, as the pipeline needs to tell it (S30 R-9). Pure. The message is internal (stored, at most
 * 500 characters, never returned to a caller).
 */

/** The source can never become a video (probe rules): the video fails at once, no retry. */
export class PermanentTaskError extends Error {
  constructor(
    readonly failureCode: PermanentFailureCode,
    message = failureCode,
  ) {
    super(message);
    this.name = 'PermanentTaskError';
  }
}

/** A storage call failed or timed out: retried like any transient cause, reported as `storage_unavailable`. */
export class StorageTaskError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageTaskError';
  }
}

/** A transient cause that is neither storage nor the clock: an encoder crash, a missing output. */
export class TransientTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientTaskError';
  }
}

/** The worker is shutting down: the task goes back to `QUEUED` without an attempt. */
export class ShutdownTaskError extends Error {
  constructor() {
    super('the worker is shutting down');
    this.name = 'ShutdownTaskError';
  }
}

/** The lease was lost while the task ran (another worker took over): nothing to record, outputs are removed. */
export class LeaseLostError extends Error {
  constructor() {
    super('the lease was lost');
    this.name = 'LeaseLostError';
  }
}
