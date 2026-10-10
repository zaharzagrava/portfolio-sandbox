import { blendSuggestions } from './suggestion-blend';

const q = (...t: string[]) => t;

describe('suggestion blend', () => {
  it('S33 AS-14: de-duplicates on normalised text, the first occurrence wins', () => {
    const out = blendSuggestions({
      limit: 8,
      queries: q('iphone 17', 'iphone charger'),
      catalog: q('IPhone  17', 'iPhone 17 Pro Case', 'iphone CHARGER'),
    });
    expect(out).toEqual([
      { text: 'iphone 17', source: 'query' },
      { text: 'iphone charger', source: 'query' },
      { text: 'iPhone 17 Pro Case', source: 'catalog' },
    ]);
  });

  const nine = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

  it.each([
    // limit, queries available, catalog available, expected query slots, expected catalog slots
    [8, 10, 10, 5, 3], // ceil(0.6×8)=5 queries, 3 catalog
    [8, 10, 0, 8, 0], // catalog empty → queries take the rest
    [8, 0, 10, 0, 5], // queries empty → catalog capped at 5
    [8, 2, 10, 2, 5], // few queries → catalog up to its cap
    [3, 10, 10, 2, 1], // ceil(0.6×3)=2
    [10, 10, 10, 6, 4], // ceil(0.6×10)=6
    [1, 10, 10, 1, 0], // one slot goes to queries
  ])(
    'S33 AS-15: limit %i, %i queries, %i catalog → %i + %i',
    (limit, nq, nc, expectedQ, expectedC) => {
      const out = blendSuggestions({
        limit,
        queries: nine('query', nq),
        catalog: nine('product', nc),
      });
      expect(out.filter((s) => s.source === 'query')).toHaveLength(expectedQ);
      expect(out.filter((s) => s.source === 'catalog')).toHaveLength(expectedC);
      expect(out.length).toBeLessThanOrEqual(limit);
    },
  );

  it('queries come before catalog entries', () => {
    const out = blendSuggestions({
      limit: 4,
      queries: q('a one', 'a two'),
      catalog: q('a three'),
    });
    expect(out.map((s) => s.source)).toEqual(['query', 'query', 'catalog']);
  });

  it('typo entries are used only when the query index and the catalog both return nothing', () => {
    expect(
      blendSuggestions({
        limit: 8,
        queries: [],
        catalog: [],
        typo: q('iphone'),
      }),
    ).toEqual([{ text: 'iphone', source: 'typo' }]);
    expect(
      blendSuggestions({
        limit: 8,
        queries: [],
        catalog: q('iPhone case'),
        typo: q('iphone'),
      }),
    ).toEqual([{ text: 'iPhone case', source: 'catalog' }]);
  });
});
