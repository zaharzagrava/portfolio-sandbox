import { KNOWLEDGE_FAILURE_CODES } from '@marketplace-sandbox/contracts';

/** The closed list of reasons a document ends `FAILED`; the seller can act on each one (S47 FR-006). */
export const FAILURE_CODES = KNOWLEDGE_FAILURE_CODES;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const isFailureCode = (value: unknown): value is FailureCode =>
  typeof value === 'string' &&
  (FAILURE_CODES as readonly string[]).includes(value);

/**
 * A problem that will fail the same way on every delivery: the document is marked `FAILED(code)` and the task is
 * acknowledged. `message` is the code (safe to log); `detail` keeps the parser text for the worker's own diagnosis and
 * never reaches a response or a log line.
 */
export class IngestFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'IngestFailure';
  }
}
