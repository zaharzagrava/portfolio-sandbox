import {
  EVENT_STATUSES,
  assertEventTransition,
  canTransitionEvent,
  eventTransitionConflict,
  type EventStatus,
} from './event-state';

const ALLOWED: [EventStatus, EventStatus][] = [
  ['SCHEDULED', 'ON_SALE'],
  ['ON_SALE', 'SOLD_OUT'],
  ['SCHEDULED', 'CLOSED'],
  ['ON_SALE', 'CLOSED'],
  ['SOLD_OUT', 'CLOSED'],
];

const ALL_PAIRS = EVENT_STATUSES.flatMap((from) =>
  EVENT_STATUSES.map((to) => [from, to] as [EventStatus, EventStatus]),
);
const key = (p: [string, string]) => p.join('>');
const REJECTED = ALL_PAIRS.filter(
  (p) => !ALLOWED.some((a) => key(a) === key(p)),
);

describe('S22 event state machine', () => {
  it.each(ALLOWED)('S22 AS-56: %s → %s is allowed', (from, to) => {
    expect(canTransitionEvent(from, to)).toBe(true);
    expect(() => assertEventTransition(from, to)).not.toThrow();
  });

  it.each(REJECTED)(
    'S22 AS-56: %s → %s is rejected with its conflict code',
    (from, to) => {
      expect(canTransitionEvent(from, to)).toBe(false);
      expect(() => assertEventTransition(from, to)).toThrow(
        expect.objectContaining({ code: eventTransitionConflict(from, to) }),
      );
    },
  );

  it.each([
    ['CLOSED', 'CLOSED', 'EVENT_ALREADY_CLOSED'],
    ['CLOSED', 'ON_SALE', 'EVENT_CLOSED'],
    ['SOLD_OUT', 'ON_SALE', 'EVENT_SOLD_OUT'],
    ['SCHEDULED', 'SOLD_OUT', 'EVENT_NOT_ON_SALE'],
  ] as const)('S22 AS-56: %s → %s answers %s', (from, to, code) => {
    expect(eventTransitionConflict(from, to)).toBe(code);
  });
});
