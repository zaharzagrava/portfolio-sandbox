import * as fc from 'fast-check';
import { commissionOf, sumCommission } from './commission';

describe('S16 commission of a line (FR-011)', () => {
  it.each([
    [10000, 1000, 1000],
    [20000, 1000, 2000],
    [500, 1000, 50],
    [4005, 1000, 401],
    [30000, 700, 2100],
    [30000, 900, 2700],
    [500, 900, 45],
    [4005, 900, 360],
    [1, 5000, 1],
    [1, 4999, 0],
    [0, 10000, 0],
  ])(
    'S16 AS-43: commission of %i at %i bps is %i (half up)',
    (total, bps, expected) => {
      expect(commissionOf(total, bps)).toBe(expected);
    },
  );

  it('S16 AS-43: a shop total is rounded per line and summed, not per order', () => {
    // 2745 = 900 + 1800 + 45; rounding the 30500 total once would give 2745 as well, but two halves differ:
    expect(sumCommission([{ lineTotalMinor: 5, rateBps: 1000 }, { lineTotalMinor: 5, rateBps: 1000 }])).toBe(2);
    expect(commissionOf(10, 1000)).toBe(1);
    expect(
      sumCommission([
        { lineTotalMinor: 10000, rateBps: 900 },
        { lineTotalMinor: 20000, rateBps: 900 },
        { lineTotalMinor: 500, rateBps: 900 },
      ]),
    ).toBe(2745);
  });

  const total = fc.integer({ min: 0, max: 1_000_000_000_000 });
  const bps = fc.integer({ min: 0, max: 10_000 });

  it('S16 FR-011: 0 <= commission <= lineTotal', () => {
    fc.assert(
      fc.property(total, bps, (t, r) => {
        const c = commissionOf(t, r);
        return c >= 0 && c <= t;
      }),
    );
  });

  it('S16 FR-011: rate 0 gives 0 and rate 10000 gives the whole line', () => {
    fc.assert(
      fc.property(total, (t) => {
        return commissionOf(t, 0) === 0 && commissionOf(t, 10_000) === t;
      }),
    );
  });

  it('S16 FR-011: commission is monotone in the rate', () => {
    fc.assert(
      fc.property(total, bps, bps, (t, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        return commissionOf(t, low) <= commissionOf(t, high);
      }),
    );
  });

  it('S16 FR-011: matches the integer formula floor((t * r + 5000) / 10000)', () => {
    fc.assert(
      fc.property(total, bps, (t, r) => {
        return (
          BigInt(commissionOf(t, r)) ===
          (BigInt(t) * BigInt(r) + 5000n) / 10000n
        );
      }),
    );
  });

  it('S16 FR-011: refuses a rate outside 0..10000 and non-integers', () => {
    expect(() => commissionOf(100, -1)).toThrow();
    expect(() => commissionOf(100, 10001)).toThrow();
    expect(() => commissionOf(100.5, 100)).toThrow();
  });
});
