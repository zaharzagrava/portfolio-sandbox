import fc from 'fast-check';
import {
  functionDiscounts,
  shopDiscount,
  type PricedLine,
} from './discount-amount';

type Output = {
  discounts: {
    lineIndex: number;
    type: 'percentage' | 'fixedPerUnit';
    value: number;
    message: string;
  }[];
};
const line = (unitPriceMinor: number, quantity: number): PricedLine => ({
  unitPriceMinor,
  quantity,
});
const pct = (lineIndex: number, value: number) => ({
  lineIndex,
  type: 'percentage' as const,
  value,
  message: 'm',
});
const fixed = (lineIndex: number, value: number) => ({
  lineIndex,
  type: 'fixedPerUnit' as const,
  value,
  message: 'm',
});

describe('S45 AS-26: output to money', () => {
  it.each<[string, PricedLine[], Output['discounts'], number[] | null]>([
    ['percentage floors in integers', [line(1000, 3)], [pct(0, 33.33)], [999]],
    ['percentage that rounds to zero', [line(1, 1)], [pct(0, 50)], [0]],
    [
      'fixed is capped at the unit price',
      [line(999, 1)],
      [fixed(0, 5000)],
      [999],
    ],
    ['fixed per unit times quantity', [line(1200, 3)], [fixed(0, 200)], [600]],
    [
      'percentage over 100 clamps to 100',
      [line(500, 2)],
      [pct(0, 250)],
      [1000],
    ],
    [
      'several discounts on a line add up and clamp to the line gross',
      [line(1000, 1)],
      [pct(0, 70), fixed(0, 600)],
      [1000],
    ],
    [
      'a lineIndex outside the lines is invalid',
      [line(10, 1)],
      [fixed(1, 1)],
      null,
    ],
    [
      'a fractional fixedPerUnit is invalid',
      [line(10, 1)],
      [fixed(0, 1.5)],
      null,
    ],
    [
      'a non-finite value is invalid',
      [line(10, 1)],
      [fixed(0, Infinity)],
      null,
    ],
    [
      'more than two decimals is invalid',
      [line(10, 1)],
      [pct(0, 10.001)],
      null,
    ],
    ['an empty output is a zero vector', [line(10, 2), line(5, 1)], [], [0, 0]],
  ])('%s', (_name, lines, discounts, expected) => {
    expect(functionDiscounts(lines, { discounts })).toEqual(expected);
  });

  it('S45 AS-27: the largest discount per line wins, in any order, and the shop total is clamped to the gross', () => {
    const lines = [line(1000, 2)];
    const f1 = functionDiscounts(lines, { discounts: [pct(0, 10)] })!;
    const f2 = functionDiscounts(lines, { discounts: [fixed(0, 50)] })!;
    expect(f1).toEqual([200]);
    expect(f2).toEqual([100]);
    expect(shopDiscount(lines, [f1, f2])).toBe(200);
    expect(shopDiscount(lines, [f2, f1])).toBe(200);
    expect(shopDiscount(lines, [[5_000]])).toBe(2000);
    expect(shopDiscount(lines, [])).toBe(0);
  });

  const lineArb = fc.record({
    unitPriceMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
    quantity: fc.integer({ min: 1, max: 1000 }),
  });
  it('property over 10,000 random lines and outputs: integer, within the gross, deterministic', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 6 }),
        (lines, picks) => {
          const output = {
            discounts: picks.map((p, i) => ({
              lineIndex: p % lines.length,
              type: i % 2 ? ('percentage' as const) : ('fixedPerUnit' as const),
              value:
                i % 2
                  ? 1 + ((p * 7919 + i * 31) % 10_000) / 100
                  : 1 + ((p * 7919 + i * 31) % 100_000),
              message: 'm',
            })),
          };
          const vector = functionDiscounts(lines, output);
          fc.pre(vector !== null);
          const total = shopDiscount(lines, [vector!]);
          const gross = lines.reduce(
            (s, l) => s + l.unitPriceMinor * l.quantity,
            0,
          );
          expect(Number.isInteger(total)).toBe(true);
          expect(total).toBeGreaterThanOrEqual(0);
          expect(total).toBeLessThanOrEqual(gross);
          expect(shopDiscount(lines, [vector!])).toBe(total);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('property: the amount is monotone in the percentage value', () => {
    fc.assert(
      fc.property(
        lineArb,
        fc.integer({ min: 1, max: 9_999 }),
        fc.integer({ min: 1, max: 100 }),
        (l, bps, extra) => {
          const low = functionDiscounts([l], {
            discounts: [pct(0, bps / 100)],
          })!;
          const high = functionDiscounts([l], {
            discounts: [pct(0, Math.min(100, bps / 100 + extra / 100))],
          })!;
          expect(high[0]).toBeGreaterThanOrEqual(low[0]);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
