import * as fc from 'fast-check';
import { computeReserve, planPayout } from './reserve';

describe('reserve arithmetic (S15 AS-04)', () => {
  it.each([
    [50_000, 1000, 5000, 45_000],
    [12_345, 1000, 1235, 11_110],
    [1001, 1000, 101, 900],
    [20_000, 0, 0, 20_000],
    [20_000, 5000, 10_000, 10_000],
    [0, 1000, 0, 0],
  ])(
    'S15 AS-04: balance %i at %i bps holds %i and pays %i',
    (balance, bps, reserveMinor, payoutMinor) => {
      expect(computeReserve(balance, bps)).toEqual({
        reserveMinor,
        payoutMinor,
      });
    },
  );

  it('S15 AS-04: the 2^53 edge is exact (the product exceeds 2^53)', () => {
    const balance = Number.MAX_SAFE_INTEGER;
    const { reserveMinor, payoutMinor } = computeReserve(balance, 1000);
    expect(reserveMinor + payoutMinor).toBe(balance);
    expect(reserveMinor).toBe(
      Number((BigInt(balance) * 1000n + 9999n) / 10000n),
    );
    expect(Number.isSafeInteger(reserveMinor)).toBe(true);
  });

  it('S15 AS-04: reserve + payout = balance and 0 <= reserve <= balance, for any balance and bps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 5000 }),
        (balance, bps) => {
          const { reserveMinor, payoutMinor } = computeReserve(balance, bps);
          expect(reserveMinor + payoutMinor).toBe(balance);
          expect(reserveMinor).toBeGreaterThanOrEqual(0);
          expect(reserveMinor).toBeLessThanOrEqual(balance);
          expect(Number.isSafeInteger(reserveMinor)).toBe(true);
        },
      ),
    );
  });

  it.each([
    [-1, 1000],
    [1.5, 1000],
    [1000, -1],
    [1000, 5001],
    [1000, 1.5],
    [Number.MAX_SAFE_INTEGER + 1, 1000],
    [Number.NaN, 1000],
  ])('S15 AS-04: balance %p at %p bps is refused', (balance, bps) => {
    expect(() => computeReserve(balance, bps)).toThrow();
  });
});

describe('payout plan: minimum and cap (S15 AS-06, AS-07)', () => {
  const limits = { minMinor: 1000, capMinor: 5_000_000 };

  it('S15 AS-06: the minimum is inclusive on the balance', () => {
    expect(planPayout(1000, 0, limits)).toEqual({
      kind: 'pay',
      amountMinor: 1000,
      reserveHeldMinor: 0,
    });
    expect(planPayout(999, 0, limits)).toEqual({
      kind: 'skip',
      reason: 'below_minimum',
    });
  });

  it('S15 AS-06: the minimum is checked again after the reserve (1050 at 10% leaves 945)', () => {
    expect(planPayout(1050, 1000, limits)).toEqual({
      kind: 'skip',
      reason: 'below_minimum',
    });
    expect(planPayout(1112, 1000, limits)).toEqual({
      kind: 'pay',
      amountMinor: 1000,
      reserveHeldMinor: 112,
    });
  });

  it('S15 AS-07: the cap limits the payout and is not counted as reserve', () => {
    expect(planPayout(6_000_000, 0, limits)).toEqual({
      kind: 'pay',
      amountMinor: 5_000_000,
      reserveHeldMinor: 0,
    });
    expect(planPayout(5_000_000, 0, limits)).toEqual({
      kind: 'pay',
      amountMinor: 5_000_000,
      reserveHeldMinor: 0,
    });
  });

  it('S15 AS-07: a reserve and the cap together hold only the reserve', () => {
    expect(planPayout(6_000_000, 1000, limits)).toEqual({
      kind: 'pay',
      amountMinor: 5_000_000,
      reserveHeldMinor: 600_000,
    });
  });

  it.each([0, -500])('S15 AS-08: a balance of %i has nothing to pay', (b) => {
    expect(planPayout(b, 1000, limits)).toEqual({
      kind: 'skip',
      reason: 'below_minimum',
    });
  });
});
