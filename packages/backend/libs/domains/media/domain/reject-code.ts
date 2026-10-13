import { MEDIA_REJECT_CODES } from '@marketplace-sandbox/contracts';
import type { MediaRejectCode } from '@marketplace-sandbox/contracts';

/** The closed vocabulary of AS-16. A decoder message never becomes a code. */
export { MEDIA_REJECT_CODES };
export type RejectCode = MediaRejectCode;

/** A permanent refusal of the input (the photo ends `REJECTED`). Anything else thrown while processing is transient. */
export class RejectedImageError extends Error {
  constructor(
    readonly code: RejectCode,
    /** The decoder's own words: for the caller's log only, never stored, never returned (FR-018). */
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'RejectedImageError';
  }
}

/** Storage, scanner, timeout or database trouble: the message is not acknowledged and the queue retries. */
export class TransientProcessingError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientProcessingError';
  }
}
