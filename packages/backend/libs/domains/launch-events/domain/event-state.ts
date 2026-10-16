import { assertNever } from '@app/common/core/assert-never';
import { LaunchEventError, type LaunchEventProblemCode } from './errors';

/** The launch-event status machine (S22 FR-043, AS-56). Pure: stores apply it with `UPDATE … WHERE status = :from`. */
export const EVENT_STATUSES = [
  'SCHEDULED',
  'ON_SALE',
  'SOLD_OUT',
  'CLOSED',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

const NEXT: Record<EventStatus, readonly EventStatus[]> = {
  SCHEDULED: ['ON_SALE', 'CLOSED'],
  ON_SALE: ['SOLD_OUT', 'CLOSED'],
  SOLD_OUT: ['CLOSED'],
  CLOSED: [],
};

export const canTransitionEvent = (from: EventStatus, to: EventStatus) =>
  NEXT[from].includes(to);

/** The conflict code of an attempt that leaves `from` the wrong way. Exhaustive: a new status fails the type check. */
export const eventTransitionConflict = (
  from: EventStatus,
  to: EventStatus,
): LaunchEventProblemCode => {
  switch (from) {
    case 'CLOSED':
      return to === 'CLOSED' ? 'EVENT_ALREADY_CLOSED' : 'EVENT_CLOSED';
    case 'SOLD_OUT':
      return 'EVENT_SOLD_OUT';
    case 'SCHEDULED':
    case 'ON_SALE':
      return 'EVENT_NOT_ON_SALE';
    default:
      return assertNever(from, 'Unhandled event status');
  }
};

export const assertEventTransition = (from: EventStatus, to: EventStatus) => {
  if (!canTransitionEvent(from, to))
    throw new LaunchEventError(eventTransitionConflict(from, to));
};

/** Holds and joins need `ON_SALE` (holds) or an open event (joins); the error answers the status the event is in. */
export const holdGateConflict = (
  status: EventStatus,
): LaunchEventProblemCode | null => {
  switch (status) {
    case 'ON_SALE':
      return null;
    case 'SCHEDULED':
      return 'EVENT_NOT_ON_SALE';
    case 'SOLD_OUT':
      return 'EVENT_SOLD_OUT';
    case 'CLOSED':
      return 'EVENT_CLOSED';
    default:
      return assertNever(status, 'Unhandled event status');
  }
};
