import { assertNever } from '@app/common/core/assert-never';

export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'DEAD',
  'CANCELLED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_EVENTS = [
  'claim',
  'complete',
  'retry',
  'release',
  'reap',
  'fail',
  'cancel',
  'operatorRetry',
] as const;

export type JobEvent = (typeof JOB_EVENTS)[number];

export class IllegalJobTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly event: JobEvent,
  ) {
    super(`illegal job transition: ${from} --${event}-->`);
    this.name = 'IllegalJobTransitionError';
  }
}

/**
 * The one status an event may start from. Every SQL change is a conditional update from exactly this status,
 * so a lost race (cancel vs claim, two retries) leaves zero rows instead of a bad state.
 */
export function sourceStatus(event: JobEvent): JobStatus {
  switch (event) {
    case 'claim':
    case 'cancel':
      return 'QUEUED';
    case 'complete':
    case 'retry':
    case 'release':
    case 'reap':
    case 'fail':
      return 'RUNNING';
    case 'operatorRetry':
      return 'DEAD';
    default:
      return assertNever(event, 'unhandled job event');
  }
}

function targetStatus(event: JobEvent): JobStatus {
  switch (event) {
    case 'claim':
      return 'RUNNING';
    case 'complete':
      return 'SUCCEEDED';
    case 'retry':
    case 'release':
    case 'reap':
    case 'operatorRetry':
      return 'QUEUED';
    case 'fail':
      return 'DEAD';
    case 'cancel':
      return 'CANCELLED';
    default:
      return assertNever(event, 'unhandled job event');
  }
}

export function canTransition(from: JobStatus, event: JobEvent): boolean {
  return sourceStatus(event) === from;
}

export function nextStatus(from: JobStatus, event: JobEvent): JobStatus {
  if (!canTransition(from, event))
    throw new IllegalJobTransitionError(from, event);
  return targetStatus(event);
}

/** SUCCEEDED and CANCELLED never change again; DEAD can be re-queued by an operator. */
export function isTerminal(status: JobStatus): boolean {
  switch (status) {
    case 'SUCCEEDED':
    case 'CANCELLED':
      return true;
    case 'QUEUED':
    case 'RUNNING':
    case 'DEAD':
      return false;
    default:
      return assertNever(status, 'unhandled job status');
  }
}

export function describeStatus(status: JobStatus): string {
  switch (status) {
    case 'QUEUED':
      return 'waiting for a worker';
    case 'RUNNING':
      return 'held by a worker';
    case 'SUCCEEDED':
      return 'finished';
    case 'DEAD':
      return 'failed for good, waiting for an operator';
    case 'CANCELLED':
      return 'cancelled before it ran';
    default:
      return assertNever(status, 'unhandled job status');
  }
}
