import * as fc from 'fast-check';
import {
  allocateLargestRemainder,
  InvalidDiscountError,
  priceCart,
  type PricedCartInput,
} from './money-allocation';

describe('S10 AS-23: largest-remainder allocation', () => {
  it.each([
    [
      '100 over 3333,3333,3334 → 33,33,34',
      100,
      [3333, 3333, 3334],
      [33, 33, 34],
    ],
    ['ties go to the earlier line', 1, [10, 10], [1, 0]],
    ['two units over three equal weights', 2, [5, 5, 5], [1, 1, 0]],
    ['zero discount', 0, [100, 200], [0, 0]],
    ['whole discount', 300, [100, 200], [100, 200]],
    ['single line', 7, [50], [7]],
    ['zero-weight lines get nothing', 5, [0, 10, 0], [0, 5, 0]],
  ])('S10 AS-23: %s', (_n, total, weights, expected) => {
    expect(allocateLargestRemainder(total, weights)).toEqual(expected);
  });

  it('S10 AS-23: a discount above the gross is refused', () => {
    expect(() => allocateLargestRemainder(101, [50, 50])).toThrow(
      InvalidDiscountError,
    );
    expect(() => allocateLargestRemainder(-1, [50, 50])).toThrow(
      InvalidDiscountError,
    );
    expect(() => allocateLargestRemainder(1.5, [50, 50])).toThrow(
      InvalidDiscountError,
    );
  });
});

describe('S10 AS-25: priceCart money invariants', () => {
  const shopA = '00000000-0000-4000-8000-00000000000a';
  const shopB = '00000000-0000-4000-8000-00000000000b';

  it('S10 AS-23/AS-24: discount per shop is allocated over that shop’s lines only', () => {
    const r = priceCart({
      lines: [
        { productId: 'p1', shopId: shopA, unitPriceMinor: 1000, quantity: 2 },
        { productId: 'p2', shopId: shopA, unitPriceMinor: 500, quantity: 1 },
        { productId: 'p3', shopId: shopB, unitPriceMinor: 700, quantity: 1 },
      ],
      shopDiscounts: [{ shopId: shopA, discountMinor: 300 }],
    });
    expect(r.lines.map((l) => l.discountMinor)).toEqual([240, 60, 0]);
    expect(r.lines.map((l) => l.lineTotalMinor)).toEqual([1760, 440, 700]);
    expect(r.shops).toEqual([
      { shopId: shopA, subtotalMinor: 2200 },
      { shopId: shopB, subtotalMinor: 700 },
    ]);
    expect(r.totalMinor).toBe(2900);
    expect(r.grossMinor).toBe(3200);
  });

  it.each<[string, PricedCartInput['shopDiscounts']]>([
    ['negative', [{ shopId: shopA, discountMinor: -1 }]],
    ['non-integer', [{ shopId: shopA, discountMinor: 1.5 }]],
    ['over the shop gross', [{ shopId: shopA, discountMinor: 1001 }]],
    ['unknown shop', [{ shopId: 'nope', discountMinor: 1 }]],
    ['NaN', [{ shopId: shopA, discountMinor: NaN }]],
  ])('S10 AS-24: a %s discount is refused', (_n, shopDiscounts) => {
    expect(() =>
      priceCart({
        lines: [
          { productId: 'p1', shopId: shopA, unitPriceMinor: 1000, quantity: 1 },
        ],
        shopDiscounts,
      }),
    ).toThrow(InvalidDiscountError);
  });

  it('S10 AS-25: properties over 10,000 random carts', () => {
    const shops = ['s0', 's1', 's2', 's3'];
    const lineArb = fc.record({
      shopId: fc.constantFrom(...shops),
      unitPriceMinor: fc.integer({ min: 1, max: 1_000_000 }),
      quantity: fc.integer({ min: 1, max: 20 }),
    });
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 12 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: 4,
          maxLength: 4,
        }),
        (rawLines, ratios) => {
          const lines = rawLines.map((l, i) => ({ ...l, productId: `p${i}` }));
          const gross = (shopId: string) =>
            lines
              .filter((l) => l.shopId === shopId)
              .reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
          const shopDiscounts = shops
            .filter((s) => gross(s) > 0)
            .map((s, i) => ({
              shopId: s,
              discountMinor: Math.floor(gross(s) * ratios[i]),
            }));
          const r = priceCart({ lines, shopDiscounts });
          let totalFromLines = 0;
          r.lines.forEach((l, i) => {
            const g = lines[i].unitPriceMinor * lines[i].quantity;
            expect(Number.isInteger(l.discountMinor)).toBe(true);
            expect(l.discountMinor).toBeGreaterThanOrEqual(0);
            expect(l.discountMinor).toBeLessThanOrEqual(g);
            expect(l.lineTotalMinor).toBe(g - l.discountMinor);
            totalFromLines += l.lineTotalMinor;
          });
          for (const s of r.shops) {
            const d =
              shopDiscounts.find((x) => x.shopId === s.shopId)?.discountMinor ??
              0;
            const shopLines = r.lines.filter((l) => l.shopId === s.shopId);
            expect(shopLines.reduce((a, l) => a + l.discountMinor, 0)).toBe(d);
            expect(s.subtotalMinor).toBe(
              shopLines.reduce((a, l) => a + l.lineTotalMinor, 0),
            );
            // ±1 of the proportional share
            const g = gross(s.shopId);
            for (const l of shopLines) {
              const share = (d * (l.unitPriceMinor * l.quantity)) / g;
              expect(Math.abs(l.discountMinor - share)).toBeLessThan(1 + 1e-6);
            }
          }
          expect(r.totalMinor).toBe(totalFromLines);
          expect(r.totalMinor).toBe(
            r.shops.reduce((a, s) => a + s.subtotalMinor, 0),
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});
