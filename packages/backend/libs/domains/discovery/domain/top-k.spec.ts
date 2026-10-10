import * as fc from 'fast-check';
import { TopK } from './top-k';

describe('S35 min-heap of the K heaviest (U2)', () => {
  it('S35 AS-24: the worked table - a:5 b:3 c:4 d:9 e:2 b:7 with K = 3', () => {
    const heap = new TopK(3);
    const steps: [string, number, string[]][] = [
      ['a', 5, ['a']],
      ['b', 3, ['a', 'b']],
      ['c', 4, ['a', 'c', 'b']],
      ['d', 9, ['d', 'a', 'c']], // d beats the minimum b (3) and evicts it
      ['e', 2, ['d', 'a', 'c']], // e does not beat the minimum c (4): never enters
      ['b', 7, ['d', 'b', 'a']], // b beats the minimum c (4) and evicts it
    ];
    for (const [key, count, expected] of steps) {
      heap.offer(key, count);
      expect(heap.top().map((e) => e.key)).toEqual(expected);
      expect(heap.size).toBeLessThanOrEqual(3);
    }
    expect(heap.top()).toEqual([
      { key: 'd', count: 9 },
      { key: 'b', count: 7 },
      { key: 'a', count: 5 },
    ]);
  });

  it('S35 AS-24: an offer for a key already held updates it in place', () => {
    const heap = new TopK(3);
    heap.offer('a', 1);
    heap.offer('b', 2);
    heap.offer('a', 10);
    heap.offer('a', 11);
    expect(heap.size).toBe(2);
    expect(heap.top()).toEqual([
      { key: 'a', count: 11 },
      { key: 'b', count: 2 },
    ]);
  });

  it('S35 AS-24: a new key enters only when it beats the current minimum (a tie does not)', () => {
    const heap = new TopK(2);
    heap.offer('a', 5);
    heap.offer('b', 5);
    heap.offer('c', 5);
    expect(heap.top().map((e) => e.key)).toEqual(['a', 'b']);
    heap.offer('c', 6);
    // c enters and evicts the larger key of the two minimums, so the order stays deterministic
    expect(heap.top().map((e) => e.key)).toEqual(['c', 'a']);
  });

  it('S35 AS-24: ties are ordered by key ascending by code unit, not by locale', () => {
    const heap = new TopK(10);
    // localeCompare would put 'a' before 'B' and 'é' before 'z'; code units put 'B' < 'a' and 'z' < 'é'
    for (const key of ['a', 'B', 'é', 'z', 'Z', '_']) heap.offer(key, 7);
    expect(heap.top().map((e) => e.key)).toEqual([
      'B',
      'Z',
      '_',
      'a',
      'z',
      'é',
    ]);
  });

  it('S35 AS-24: property - the heap equals the K largest of an exact count', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 60 }),
            fc.integer({ min: 1, max: 4 }),
          ),
          {
            maxLength: 400,
          },
        ),
        fc.integer({ min: 1, max: 10 }),
        (events, k) => {
          // feeding exact running counts, as the sketch does when it has no collisions
          const exact = new Map<string, number>();
          const heap = new TopK(k);
          for (const [id, weight] of events) {
            const key = `p${id}`;
            const count = (exact.get(key) ?? 0) + weight;
            exact.set(key, count);
            heap.offer(key, count);
          }
          const expected = [...exact]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, k);
          const got = heap.top();
          // the order is total (count descending, key ascending), so membership is exact too
          return (
            got.length === expected.length &&
            got.every(
              (e, i) => e.count === expected[i][1] && e.key === expected[i][0],
            )
          );
        },
      ),
      { seed: 7, numRuns: 150 },
    );
  });
});
