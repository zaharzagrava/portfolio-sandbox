import fc from 'fast-check';
import {
  BASE_FEE_MINOR,
  SURGE_MAX,
  SURGE_MIN,
  SURGE_STEP,
  feeForSurge,
  surgeFromRatio,
} from './surge-fee';

const STEPS = [100, 125, 150, 175, 200, 225, 250, 275, 300];
const FEES = [499, 624, 749, 873, 998, 1123, 1248, 1372, 1497];

describe('surge fee', () => {
  it('S20 AS-50: the base is 499 and surge runs 1.00 to 3.00 in 0.25 steps', () => {
    expect(BASE_FEE_MINOR).toBe(499);
    expect([SURGE_MIN, SURGE_MAX, SURGE_STEP]).toEqual([100, 300, 25]);
  });

  it.each(STEPS.map((s, i) => [s, FEES[i]]))(
    'S20 AS-50: surge %i hundredths costs %i minor units',
    (surge, fee) => {
      expect(feeForSurge(surge)).toBe(fee);
    },
  );

  it('S20 AS-50: any step gives an integer fee between 499 and 1497, non-decreasing in surge', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const feeLo = feeForSurge(SURGE_MIN + lo * SURGE_STEP);
          const feeHi = feeForSurge(SURGE_MIN + hi * SURGE_STEP);
          expect(Number.isInteger(feeLo)).toBe(true);
          expect(Number.isInteger(feeHi)).toBe(true);
          expect(feeLo).toBeGreaterThanOrEqual(499);
          expect(feeHi).toBeLessThanOrEqual(1497);
          expect(feeHi).toBeGreaterThanOrEqual(feeLo);
        },
      ),
    );
  });

  it('S20 AS-50: a surge outside the steps is refused', () => {
    expect(() => feeForSurge(99)).toThrow();
    expect(() => feeForSurge(301)).toThrow();
    expect(() => feeForSurge(110)).toThrow();
    expect(() => feeForSurge(1.5)).toThrow();
  });

  it.each([
    [3, 1, 300],
    [30, 1, 300],
    [5, 4, 125],
    [6, 4, 150],
    [2, 1, 200],
    [9, 4, 225],
    [7, 4, 175],
    [11, 4, 275],
  ])(
    'S20 AS-49: demand %i over supply %i gives %i hundredths',
    (demand, supply, expected) => {
      expect(surgeFromRatio(demand, supply)).toBe(expected);
    },
  );

  it.each([
    [0, 0],
    [0, 5],
    [1, 1],
    [3, 3],
    [2, 5],
    [1, 0],
    [17, 16],
  ])(
    'S20 AS-49: demand %i over supply %i (ratio at most 1 after rounding) has no entry',
    (demand, supply) => {
      expect(surgeFromRatio(demand, supply)).toBeNull();
    },
  );

  it('S20 AS-49: the multiplier is clamped to 1.0..3.0 on steps of 0.25 for any ratio', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 500 }),
        (demand, supply) => {
          const surge = surgeFromRatio(demand, supply);
          if (surge === null) return;
          expect(surge).toBeGreaterThan(SURGE_MIN);
          expect(surge).toBeLessThanOrEqual(SURGE_MAX);
          expect((surge - SURGE_MIN) % SURGE_STEP).toBe(0);
        },
      ),
    );
  });
});
