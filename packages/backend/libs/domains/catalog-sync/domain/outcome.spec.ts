import {
  classifyCatalogFailure,
  classifyStock,
  clampDelta,
} from './sync-outcome';

const MAX = 1_000_000_000;

describe('stock outcome', () => {
  it.each([
    ['sells part of what is left', -3, 1, { applied: -1, shortfall: 2 }],
    ['sells the last unit', -1, 1, { applied: -1, shortfall: 0 }],
    ['sells from nothing', -1, 0, { applied: 0, shortfall: 1 }],
    ['an exact fit', -2, 2, { applied: -2, shortfall: 0 }],
    ['one more than there is', -3, 2, { applied: -2, shortfall: 1 }],
    ['a receipt', 5, 0, { applied: 5, shortfall: 0 }],
  ])('S09 AS-09: clamp, %s', (_name, requested, quantity, expected) => {
    expect(clampDelta(requested, quantity)).toEqual({
      requested,
      ...expected,
    });
  });

  it.each([
    ['fits', 3, 10, 'full'],
    ['sells all of it', -10, 10, 'full'],
    ['oversells', -11, 10, 'oversold'],
    ['reaches the limit exactly', 5, MAX - 5, 'full'],
    ['exceeds the limit', 5, MAX - 4, 'quantity_limit'],
    ['a receipt of 100000 on a full shelf', 100_000, MAX, 'quantity_limit'],
  ])('S09 AS-10: classify, %s', (_name, delta, quantity, kind) => {
    expect(classifyStock(delta, quantity, MAX).kind).toBe(kind);
  });

  it('S09 AS-09: an oversold delta carries its numbers', () => {
    expect(classifyStock(-3, 1, MAX)).toEqual({
      kind: 'oversold',
      requested: -3,
      applied: -1,
      shortfall: 2,
    });
  });

  it('S09 AS-10: a quantity limit conflict applies nothing', () => {
    expect(classifyStock(100_000, MAX - 10, MAX)).toEqual({
      kind: 'quantity_limit',
      requested: 100_000,
      applied: 0,
      shortfall: 100_000,
    });
  });

  it.each([
    ['not_found', { result: 'rejected', code: 'unknown_product' }],
    ['unavailable', { result: 'rejected', code: 'product_unavailable' }],
    ['quantity_limit', { result: 'conflict', kind: 'quantity_limit' }],
    ['insufficient_stock', { result: 'clamp' }],
  ] as const)(
    'S09 AS-11: the catalog failure %s becomes the outcome',
    (code, expected) => {
      expect(classifyCatalogFailure(code)).toEqual(expected);
    },
  );
});
