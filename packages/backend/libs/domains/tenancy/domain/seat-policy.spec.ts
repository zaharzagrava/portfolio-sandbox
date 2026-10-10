import { seatLimit, hasFreeSeat } from './seat-policy';

describe('S03 seat policy', () => {
  it.each([
    ['STARTER', 5],
    ['PRO', 25],
    ['ENTERPRISE', 250],
  ] as const)('%s allows %i seats', (plan, limit) => {
    expect(seatLimit(plan)).toBe(limit);
  });

  it.each([
    ['STARTER', 0, 0, true],
    ['STARTER', 3, 1, true],
    ['STARTER', 4, 1, false],
    ['STARTER', 5, 0, false],
    ['STARTER', 6, 0, false], // plan lowered: nobody removed, nobody added
    ['PRO', 20, 4, true],
    ['PRO', 20, 5, false],
    ['ENTERPRISE', 249, 0, true],
    ['ENTERPRISE', 249, 1, false],
  ] as const)(
    '%s with %i members and %i pending invites -> free seat %s',
    (plan, members, pending, expected) => {
      expect(hasFreeSeat(plan, members, pending)).toBe(expected);
    },
  );
});
