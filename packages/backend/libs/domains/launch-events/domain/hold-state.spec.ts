import {
  HOLD_STATES,
  assertHoldTransition,
  canTransitionHold,
  holdConflictCode,
  type HoldState,
} from './hold-state';

const ALLOWED: [HoldState, HoldState][] = [
  ['HELD', 'CONFIRMING'],
  ['CONFIRMING', 'CONFIRMED'],
  ['CONFIRMING', 'HELD'], // the seal is undone when the booking transaction fails
  ['HELD', 'RELEASED'],
  ['HELD', 'EXPIRED'],
];
const ALL_PAIRS = HOLD_STATES.flatMap((from) =>
  HOLD_STATES.map((to) => [from, to] as [HoldState, HoldState]),
);
const REJECTED = ALL_PAIRS.filter(
  ([f, t]) => !ALLOWED.some(([af, at]) => af === f && at === t),
);

describe('S22 hold state machine', () => {
  it.each(ALLOWED)('S22 AS-56: %s → %s is allowed', (from, to) => {
    expect(canTransitionHold(from, to)).toBe(true);
    expect(() => assertHoldTransition(from, to)).not.toThrow();
  });

  it.each(REJECTED)('S22 AS-56: %s → %s is rejected', (from, to) => {
    expect(canTransitionHold(from, to)).toBe(false);
    expect(() => assertHoldTransition(from, to)).toThrow(
      expect.objectContaining({ code: holdConflictCode(from) }),
    );
  });

  it.each([
    ['EXPIRED', 'HOLD_EXPIRED'],
    ['RELEASED', 'HOLD_RELEASED'],
    ['CONFIRMED', 'HOLD_ALREADY_CONFIRMED'],
    ['CONFIRMING', 'HOLD_ALREADY_CONFIRMED'],
  ] as const)('S22 AS-37: a hold in %s answers %s', (state, code) => {
    expect(holdConflictCode(state)).toBe(code);
  });
});
