import fc from 'fast-check';
import { allocate } from './allocation';

describe('S17 AS-70: a money split is exact (largest remainder)', () => {
  const exactShare = (amount: number, weights: number[], i: number) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    return (amount * weights[i]) / sum;
  };

  it('S17 AS-70: parts are integers, sum to the amount and sit within one unit of their exact share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1_000_000 }), {
            minLength: 1,
            maxLength: 12,
          })
          .filter((w) => w.some((x) => x > 0)),
        (amount, weights) => {
          const parts = allocate(amount, weights);
          expect(parts).toHaveLength(weights.length);
          expect(parts.every(Number.isInteger)).toBe(true);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          parts.forEach((part, i) =>
            expect(
              Math.abs(part - exactShare(amount, weights, i)),
            ).toBeLessThan(1 + 1e-6),
          );
        },
      ),
      { numRuns: 2000 },
    );
  });

  it.each([
    { amount: 100, weights: [1, 1, 1], expected: [34, 33, 33] },
    { amount: 100, weights: [1, 1], expected: [50, 50] },
    { amount: 1, weights: [1, 1], expected: [1, 0] },
    { amount: 5, weights: [0, 1, 1], expected: [0, 3, 2] },
    { amount: -100, weights: [1, 1, 1], expected: [-33, -33, -34] },
  ])(
    'S17 AS-70: ties go to the earlier part ($amount over $weights)',
    ({ amount, weights, expected }) => {
      expect(allocate(amount, weights)).toEqual(expected);
    },
  );

  it('S17 AS-70: a zero weight receives nothing unless the leftover is forced onto it', () => {
    expect(allocate(7, [0, 3, 0, 4])).toEqual([0, 3, 0, 4]);
  });

  it('S17 AS-70: refuses weights that are negative, fractional or all zero', () => {
    expect(() => allocate(10, [0, 0])).toThrow();
    expect(() => allocate(10, [1, -1])).toThrow();
    expect(() => allocate(10, [1, 0.5])).toThrow();
    expect(() => allocate(10, [])).toThrow();
  });
});
