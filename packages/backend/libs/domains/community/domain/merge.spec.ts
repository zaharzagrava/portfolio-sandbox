import * as fc from 'fast-check';
import {
  compareEntries,
  decodeEntry,
  encodeEntry,
  mergeNewestFirst,
  type TimelineEntry,
} from './merge';

/** Shared by timeline reads (pushed timeline + celebrity recents + pull continuation) and timeline rebuilds. */
describe('mergeNewestFirst (k-way merge by (ms, itemId) descending)', () => {
  const e = (ms: number, id = `i${ms}`): TimelineEntry => ({ ms, itemId: id });
  const list = (...ms: number[]) => ms.map((m) => e(m));
  const ids = (entries: TimelineEntry[]) => entries.map((x) => x.itemId);

  it('S26 AS-31: empty input and empty lists give an empty page', () => {
    expect(mergeNewestFirst([], 10)).toEqual([]);
    expect(mergeNewestFirst([[], []], 10)).toEqual([]);
  });

  it('S26 AS-31: one list is returned as is up to the limit', () => {
    expect(ids(mergeNewestFirst([list(90, 50, 10)], 2))).toEqual([
      'i90',
      'i50',
    ]);
    expect(ids(mergeNewestFirst([list(90, 50, 10)], 10))).toEqual([
      'i90',
      'i50',
      'i10',
    ]);
  });

  it('S26 AS-31: several lists merge newest first and honour the limit', () => {
    const merged = mergeNewestFirst(
      [list(90, 50, 10), list(80, 20), list(70)],
      5,
    );
    expect(merged.map((x) => x.ms)).toEqual([90, 80, 70, 50, 20]);
  });

  it('S26 AS-18: equal milliseconds are ordered by itemId descending, deterministically', () => {
    const a = [e(1000, 'a'), e(1000, 'c')];
    const b = [e(1000, 'b')];
    const expected = ['c', 'b', 'a'];
    expect(ids(mergeNewestFirst([a, b], 10))).toEqual(expected);
    expect(ids(mergeNewestFirst([b, a], 10))).toEqual(expected);
  });

  it('S26 AS-26: an item present in two lists is returned once', () => {
    const merged = mergeNewestFirst(
      [
        [e(30, 'x'), e(10, 'y')],
        [e(30, 'x'), e(20, 'z')],
      ],
      10,
    );
    expect(ids(merged)).toEqual(['x', 'z', 'y']);
  });

  it('S26 AS-31: the cursor is exclusive and may sit before everything or past everything', () => {
    const lists = [[e(90, 'a'), e(50, 'b'), e(10, 'c')]];
    expect(ids(mergeNewestFirst(lists, 10, e(50, 'b')))).toEqual(['c']);
    expect(ids(mergeNewestFirst(lists, 10, e(1000, 'zzz')))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(mergeNewestFirst(lists, 10, e(0, ''))).toEqual([]);
  });

  it('S26 AS-31: a cursor inside a run of equal milliseconds resumes on the itemId tiebreak', () => {
    const lists = [[e(50, 'c'), e(50, 'b'), e(50, 'a')]];
    expect(ids(mergeNewestFirst(lists, 10, e(50, 'b')))).toEqual(['a']);
  });

  it('S26 AS-31: a numeric cursor keeps only entries strictly older than that millisecond', () => {
    expect(
      mergeNewestFirst([list(90, 50, 10), list(80, 20)], 10, 60).map(
        (x) => x.ms,
      ),
    ).toEqual([50, 20, 10]);
  });

  it('S26 AS-31: a limit larger than the total returns everything', () => {
    expect(mergeNewestFirst([list(3, 2, 1)], 1000)).toHaveLength(3);
  });

  it('S26 AS-18: a list received out of order is still merged newest first', () => {
    expect(ids(mergeNewestFirst([[e(10), e(30), e(20)]], 10))).toEqual([
      'i30',
      'i20',
      'i10',
    ]);
  });

  it('S26 AS-31: 50 lists merge into the sorted union', () => {
    const lists = Array.from({ length: 50 }, (_, k) =>
      [3, 2, 1].map((n) => e(n * 100 + k, `id-${k}-${n}`)),
    );
    const merged = mergeNewestFirst(lists, 40);
    expect(merged).toHaveLength(40);
    const all = lists.flat().sort(compareEntries);
    expect(merged).toEqual(all.slice(0, 40));
  });

  it('S26 AS-31: entries encode and decode losslessly', () => {
    const entry = e(1_700_000_000_123, '1ef0abc');
    expect(decodeEntry(encodeEntry(entry))).toEqual(entry);
  });

  it('S26 AS-31 (property): output equals the sorted de-duplicated union cut at the cursor and limit', () => {
    const entry = fc.record({
      ms: fc.integer({ min: 0, max: 20 }),
      itemId: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'),
    });
    fc.assert(
      fc.property(
        fc.array(fc.array(entry, { maxLength: 12 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 30 }),
        fc.option(entry, { nil: undefined }),
        (lists, limit, cursor) => {
          // the same item always has the same time (it is one stored item)
          const timeOf = new Map<string, number>();
          const normalized = lists.map((l) =>
            l.map((x) => {
              if (!timeOf.has(x.itemId)) timeOf.set(x.itemId, x.ms);
              return { ms: timeOf.get(x.itemId)!, itemId: x.itemId };
            }),
          );
          const sorted = normalized.map((l) => [...l].sort(compareEntries));
          const expected = [
            ...new Map(
              normalized
                .flat()
                .sort(compareEntries)
                .map((x) => [x.itemId, x] as const),
            ).values(),
          ]
            .filter((x) => !cursor || compareEntries(x, cursor) > 0)
            .slice(0, limit);
          expect(mergeNewestFirst(sorted, limit, cursor)).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
