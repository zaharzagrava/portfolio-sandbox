import fc from 'fast-check';
import { TopKTrie, type Suggestion } from './top-k-trie';

/** The trie is the autocomplete hot path on every API node. */
describe('TopKTrie', () => {
  const items: Suggestion[] = [
    { query: 'iphone 17', count: 900 },
    { query: 'iphone 17 pro max case', count: 400 },
    { query: 'iphone charger', count: 650 },
    { query: 'ipad air', count: 300 },
    { query: 'airpods pro', count: 800 },
    { query: 'café crème', count: 120 },
    { query: 'cafe latte', count: 120 },
    { query: '日本語 辞書', count: 50 },
    { query: '日本酒', count: 70 },
    { query: 'tie b', count: 10 },
    { query: 'tie a', count: 10 },
    { query: 'tie c', count: 10 },
  ];

  it.each([
    [
      'most popular first, cut at K',
      'ip',
      3,
      ['iphone 17', 'iphone charger', 'iphone 17 pro max case'],
    ],
    [
      'a longer prefix narrows the list',
      'iphone 1',
      3,
      ['iphone 17', 'iphone 17 pro max case'],
    ],
    ['a single letter', 'a', 3, ['airpods pro']],
    ['no match', 'xyz', 3, []],
    ['ties are ordered by text', 'tie', 3, ['tie a', 'tie b', 'tie c']],
    ['multi-byte characters are whole', '日本', 3, ['日本酒', '日本語 辞書']],
    [
      'accented characters differ from plain ones',
      'caf',
      3,
      ['cafe latte', 'café crème'],
    ],
    [
      'the empty prefix lists the global top',
      '',
      2,
      ['iphone 17', 'airpods pro'],
    ],
    [
      'a prefix longer than the depth is still exact',
      'iphone 17 pro max c',
      3,
      ['iphone 17 pro max case'],
    ],
    ['a prefix longer than every query', 'iphone 17 pro max case plus', 3, []],
  ])('S33 AS-52: %s', async (_name, prefix, limit, expected) => {
    const trie = await TopKTrie.buildFrom(items, 3, 8);
    expect(trie.lookup(prefix, limit).map((s) => s.query)).toEqual(expected);
  });

  it('S33 AS-52: the limit may be smaller than K', async () => {
    const trie = await TopKTrie.buildFrom(items, 10);
    expect(trie.lookup('ip', 1).map((s) => s.query)).toEqual(['iphone 17']);
  });

  const word = fc.stringMatching(/^[a-c ]{1,6}$/);
  it('S33 AS-53: lookup equals a brute-force scan (top K, count desc then text asc)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({ query: word, count: fc.integer({ min: 1, max: 20 }) }),
          { selector: (s) => s.query, maxLength: 40 },
        ),
        word,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 4 }),
        async (data, rawPrefix, k, depth) => {
          // beyond the depth the answer is best-effort (FR-004): the property covers prefixes the index can resolve
          const prefix = [...rawPrefix].slice(0, depth).join('');
          const trie = await TopKTrie.buildFrom(data, k, depth);
          const expected = data
            .filter((s) => s.query.startsWith(prefix))
            .sort(
              (a, b) =>
                b.count - a.count ||
                (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
            )
            .slice(0, k)
            .map((s) => s.query);
          expect(trie.lookup(prefix, k).map((s) => s.query)).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('S33 AS-54: nodes grow at most with queries × depth, and a scaled index stays within its memory bound', async () => {
    const depth = 20;
    const total = 20_000; // 1/10 of the 200,000-query target
    const syllables = [
      'ip',
      'ho',
      'ne',
      'ca',
      'se',
      'pro',
      'max',
      'air',
      'pod',
      'usb',
      'cab',
      'le',
      'wi',
      'fi',
    ];
    const data: Suggestion[] = Array.from({ length: total }, (_, i) => {
      let n = i;
      let query = '';
      for (let w = 0; w < 4; w++) {
        query +=
          (w ? ' ' : '') +
          syllables[n % syllables.length] +
          syllables[(n >> 3) % syllables.length];
        n = Math.floor(n / 7) + w + i;
      }
      return { query: `${query} ${i}`, count: (i * 7919) % 1000 };
    });
    const before = process.memoryUsage().heapUsed;
    const trie = await TopKTrie.buildFrom(data, 10, depth);
    const used = process.memoryUsage().heapUsed - before;
    expect(trie.size()).toBeLessThanOrEqual(total * depth + 1);
    // 400 MB for 200,000 queries is 2 KB per query; the scaled index must stay inside the same per-query bound
    expect(used).toBeLessThanOrEqual(total * 2_000);
    expect(trie.lookup('ip', 10).length).toBeGreaterThan(0);
  });
});
