import { assertNever } from '@app/common/core/assert-never';

/** Review task status machine (S04 data-model.md): `OPEN` is the only state that moves. */
export const REVIEW_TASK_STATUSES = [
  'OPEN',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ReviewTaskStatus = (typeof REVIEW_TASK_STATUSES)[number];

export const REVIEW_TASK_EVENTS = ['APPROVE', 'REJECT', 'CANCEL'] as const;
export type ReviewTaskEvent = (typeof REVIEW_TASK_EVENTS)[number];

export function nextReviewTaskStatus(
  from: ReviewTaskStatus,
  event: ReviewTaskEvent,
): ReviewTaskStatus | null {
  switch (from) {
    case 'OPEN':
      switch (event) {
        case 'APPROVE':
          return 'APPROVED';
        case 'REJECT':
          return 'REJECTED';
        case 'CANCEL':
          return 'CANCELLED';
        default:
          return assertNever(event);
      }
    case 'APPROVED':
    case 'REJECTED':
    case 'CANCELLED':
      return null;
    default:
      return assertNever(from);
  }
}
