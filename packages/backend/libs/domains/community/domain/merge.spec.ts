import { mergeNewestFirst } from './merge';

/** Shared by timeline reads (own list ⊕ celebrities) and timeline rebuilds (all followed authors). */
describe('mergeNewestFirst (k-way merge)', () => {
  const list = (...ms: number[]) => ms.map((m) => ({ ms: m, itemId: `i${m}` }));

  it('merges sorted lists newest-first, honours limit and the `before` cursor, drops duplicates', () => {
    const merged = mergeNewestFirst([list(90, 50, 10), list(80, 50, 20), list(70)], 5);
    expect(merged.map((e) => e.ms)).toEqual([90, 80, 70, 50, 20]);
    expect(mergeNewestFirst([list(90, 50, 10), list(80, 20)], 10, 60).map((e) => e.ms)).toEqual([50, 20, 10]);
  });

  it('handles empty input', () => {
    expect(mergeNewestFirst([[], []], 10)).toEqual([]);
  });
});
