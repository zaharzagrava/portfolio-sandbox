import * as fc from 'fast-check';
import {
  poolSize,
  selectVisible,
  servingWindows,
  sumAndOrder,
} from './trending-ranking';
import type { TrendingProductFacts } from './trending-ports';

const MIN = 60_000;
const at = (hhmmss: string) => Date.parse(`2026-10-10T${hhmmss}Z`);

describe('S35 serving window set (U4)', () => {
  it.each([
    ['11:59:20', '10:59:00', '11:58:00'],
    ['12:01:05', '11:01:00', '12:00:00'],
    ['12:02:05', '11:02:00', '12:01:00'],
    ['12:00:00', '11:00:00', '11:59:00'],
  ])(
    'S35 AS-18: at %s the 60 windows start %s ... %s (the current minute is excluded)',
    (now, first, last) => {
      const starts = servingWindows(at(now));
      expect(starts).toHaveLength(60);
      expect(starts[0]).toBe(at(first));
      expect(starts[59]).toBe(at(last));
      expect(starts.every((s, i) => i === 0 || s - starts[i - 1] === MIN)).toBe(
        true,
      );
    },
  );

  it('S35 AS-18: a view at 11:00:30 counts at 11:59:20 and not at 12:01:05; one at 11:01:30 counts at 12:01:05 and not at 12:02:05', () => {
    const covers = (now: string, event: string) =>
      servingWindows(at(now)).includes(Math.floor(at(event) / MIN) * MIN);
    expect(covers('11:59:20', '11:00:30')).toBe(true);
    expect(covers('12:01:05', '11:00:30')).toBe(false);
    expect(covers('12:01:05', '11:01:30')).toBe(true);
    expect(covers('12:02:05', '11:01:30')).toBe(false);
  });
});

describe('S35 ranking order (U4)', () => {
  const H = '00000000-0000-4000-8000-00000000000a';
  const I = '00000000-0000-4000-8000-00000000000b';
  const J = '00000000-0000-4000-8000-00000000000c';
  const K = '00000000-0000-4000-8000-00000000000d';

  it('S35 AS-05: score descending, equal scores by productId ascending', () => {
    const ordered = sumAndOrder([
      { productId: K, score: 40 },
      { productId: I, score: 40 },
      { productId: J, score: 50 },
      { productId: H, score: 40 },
    ]);
    expect(ordered.map((e) => e.productId)).toEqual([J, H, I, K]);
  });

  it('S35 AS-05: ties compare by code unit, not by locale', () => {
    const ordered = sumAndOrder([
      { productId: 'a', score: 1 },
      { productId: 'B', score: 1 },
      { productId: 'é', score: 1 },
      { productId: 'z', score: 1 },
    ]);
    expect(ordered.map((e) => e.productId)).toEqual(['B', 'a', 'z', 'é']);
  });

  it('S35 AS-05: duplicates are summed', () => {
    expect(
      sumAndOrder([
        { productId: H, score: 10 },
        { productId: H, score: 5 },
        { productId: I, score: 12 },
      ]),
    ).toEqual([
      { productId: H, score: 15 },
      { productId: I, score: 12 },
    ]);
  });

  it('S35 AS-05: property - the order does not depend on the input order, and replay is byte-identical', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            productId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'é', 'Z'),
            score: fc.integer({ min: 1, max: 5 }),
          }),
          { maxLength: 30 },
        ),
        fc.integer(),
        (entries, seed) => {
          const shuffled = [...entries].sort(
            (x, y) => ((x.score * 31 + seed) % 7) - ((y.score * 17 + seed) % 7),
          );
          const a = JSON.stringify(sumAndOrder(entries));
          return (
            a === JSON.stringify(sumAndOrder(shuffled)) &&
            a === JSON.stringify(sumAndOrder(entries))
          );
        },
      ),
      { seed: 5, numRuns: 100 },
    );
  });

  it.each([
    [1, 3],
    [4, 12],
    [20, 60],
    [19, 57],
  ])(
    'S35 AS-10: the pool for limit %i is %i entries (min(3 x limit, 60))',
    (limit, pool) => {
      expect(poolSize(limit)).toBe(pool);
    },
  );
});

describe('S35 visibility selection (U4)', () => {
  const facts = (
    patch: Partial<TrendingProductFacts> = {},
  ): TrendingProductFacts => ({
    title: 'Title',
    priceMinor: 1000,
    currency: 'EUR',
    category: 'audio',
    status: 'ACTIVE',
    isSandbox: false,
    inStock: true,
    shopStatus: 'ACTIVE',
    ...patch,
  });
  const pool = [
    'n1',
    'n2',
    'n3',
    'n4',
    'n5',
    'n6',
    'n7',
    'n8',
    'n9',
    'n10',
  ].map((productId, i) => ({ productId, score: 100 - i }));
  const world = new Map<string, TrendingProductFacts>([
    ['n1', facts({ inStock: false })],
    ['n2', facts({ status: 'ARCHIVED' })],
    ['n3', facts({ isSandbox: true })],
    ['n4', facts({ shopStatus: 'SUSPENDED' })],
    // n5 unknown
    ['n6', facts({ title: 'Six' })],
    ['n7', facts()],
    ['n8', facts()],
    ['n9', facts()],
    ['n10', facts()],
  ]);

  it('S35 AS-10: hidden candidates are dropped and replaced by the next visible ones, ranks 1..n', () => {
    const items = selectVisible(pool, world, 'all', 4);
    expect(items.map((i) => i.productId)).toEqual(['n6', 'n7', 'n8', 'n9']);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
    expect(items[0]).toEqual({
      rank: 1,
      productId: 'n6',
      title: 'Six',
      priceMinor: 1000,
      currency: 'EUR',
      category: 'audio',
      score: 95,
    });
  });

  it('S35 AS-12: not padded when fewer are visible, empty when none is', () => {
    expect(selectVisible(pool, world, 'all', 20)).toHaveLength(5);
    expect(selectVisible(pool.slice(0, 5), world, 'all', 20)).toEqual([]);
  });

  it('S35 AS-11: the catalog category is authoritative for a category other than all', () => {
    const mixed = new Map(world);
    mixed.set('n6', facts({ category: 'cameras' }));
    expect(
      selectVisible(pool, mixed, 'audio', 3).map((i) => i.productId),
    ).toEqual(['n7', 'n8', 'n9']);
    const all = selectVisible(pool, mixed, 'all', 1);
    expect(all[0]).toMatchObject({ productId: 'n6', category: 'cameras' });
    expect(
      selectVisible(pool, mixed, 'cameras', 5).map((i) => i.productId),
    ).toEqual(['n6']);
  });

  it('S35 AS-10: unknown ids are dropped and nothing is invented', () => {
    expect(
      selectVisible([{ productId: 'ghost', score: 9 }], new Map(), 'all', 5),
    ).toEqual([]);
  });
});
