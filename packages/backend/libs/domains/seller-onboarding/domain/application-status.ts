import { assertNever } from '@app/common/core/assert-never';

/**
 * Application status machine (S04 data-model.md, AS-70). Pure: the service applies an answer with a conditional
 * update (`WHERE status = <from>`, one row asserted) and writes the history row in the same transaction.
 */
export const APPLICATION_STATUSES = [
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_EVENTS = ['VERIFY', 'REJECT', 'RESUBMIT'] as const;
export type ApplicationEvent = (typeof APPLICATION_EVENTS)[number];

/** The status `event` leads to from `from`, or `null` when the pair is not a transition. */
export function nextApplicationStatus(
  from: ApplicationStatus,
  event: ApplicationEvent,
): ApplicationStatus | null {
  switch (from) {
    case 'SUBMITTED':
      switch (event) {
        case 'VERIFY':
          return 'VERIFIED';
        case 'REJECT':
          return 'REJECTED';
        case 'RESUBMIT':
          return null;
        default:
          return assertNever(event);
      }
    case 'REJECTED':
      switch (event) {
        case 'RESUBMIT':
          return 'SUBMITTED';
        case 'VERIFY':
        case 'REJECT':
          return null;
        default:
          return assertNever(event);
      }
    case 'VERIFIED':
      return null;
    default:
      return assertNever(from);
  }
}

/** A resubmission starts the next round. */
export const nextSubmissionNo = (current: number) => current + 1;
