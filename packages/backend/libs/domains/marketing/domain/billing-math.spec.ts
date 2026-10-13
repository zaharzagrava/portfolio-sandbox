import fc from 'fast-check';
import { billable } from './billing-math';

describe('S36 AS-57: billing arithmetic (pure)', () => {
  it.each([
    // clicks, cpc, budget, earlier, billable, capped, amount
    [30, 25, 1000, 0, 30, 0, 750],
    [20, 25, 1000, 750, 10, 10, 250],
    [5, 25, 1000, 1000, 0, 5, 0],
    [3, 25, 1000, 976, 0, 3, 0], // remaining 24 < one click
    [3, 25, 1000, 975, 1, 2, 25], // remaining 25: exactly one click
    [3, 25, 75, 0, 3, 0, 75], // remaining equals clicks x cpc: all billed, none capped
    [0, 25, 1000, 0, 0, 0, 0],
    [10, 25, 1000, 1200, 0, 10, 0], // already over budget (never negative)
  ])(
    '%i clicks at %i with budget %i after %i billed',
    (
      clicks,
      cpc,
      budget,
      earlier,
      billableClicks,
      cappedClicks,
      amountMinor,
    ) => {
      expect(billable(clicks, cpc, budget, earlier)).toEqual({
        billableClicks,
        cappedClicks,
        amountMinor,
      });
    },
  );

  it('property: whole clicks only, never above the remaining budget, integers, never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 100, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (clicks, cpc, budget, earlier) => {
          const r = billable(clicks, cpc, budget, earlier);
          expect(Number.isInteger(r.billableClicks)).toBe(true);
          expect(r.billableClicks).toBeGreaterThanOrEqual(0);
          expect(r.billableClicks).toBe(
            Math.max(0, Math.min(clicks, Math.floor((budget - earlier) / cpc))),
          );
          expect(r.amountMinor).toBe(r.billableClicks * cpc);
          expect(r.amountMinor).toBeLessThanOrEqual(
            Math.max(0, budget - earlier),
          );
          expect(r.billableClicks + r.cappedClicks).toBe(clicks);
        },
      ),
      { seed: 36, numRuns: 500 },
    );
  });

  it('property: more clicks never lower the amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 100, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (a, extra, cpc, budget, earlier) => {
          expect(
            billable(a + extra, cpc, budget, earlier).amountMinor,
          ).toBeGreaterThanOrEqual(
            billable(a, cpc, budget, earlier).amountMinor,
          );
        },
      ),
      { seed: 36, numRuns: 300 },
    );
  });

  it('rejects inputs that are not whole numbers or a non-positive CPC', () => {
    expect(() => billable(1.5, 25, 1000, 0)).toThrow(RangeError);
    expect(() => billable(1, 0, 1000, 0)).toThrow(RangeError);
    expect(() => billable(-1, 25, 1000, 0)).toThrow(RangeError);
  });
});
