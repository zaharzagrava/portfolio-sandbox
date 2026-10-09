import { normalizeQuery, TopKTrie } from './top-k-trie';

/** The trie is the autocomplete hot path on every API node. */
describe('TopKTrie', () => {
  const items = [
    { query: 'iphone 17', count: 900 },
    { query: 'iphone 17 pro max case', count: 400 },
    { query: 'iphone charger', count: 650 },
    { query: 'ipad air', count: 300 },
    { query: 'airpods pro', count: 800 },
  ];

  it('returns the top-K completions for a prefix, most popular first', async () => {
    const trie = await TopKTrie.buildFrom(items, 3);
    expect(trie.lookup('iph').map((s) => s.query)).toEqual([
      'iphone 17',
      'iphone charger',
      'iphone 17 pro max case',
    ]);
    expect(trie.lookup('ip').map((s) => s.query)).toEqual([
      'iphone 17',
      'iphone charger',
      'iphone 17 pro max case',
    ]); // K = 3
    expect(trie.lookup('a').map((s) => s.query)).toEqual(['airpods pro']);
    expect(trie.lookup('xyz')).toEqual([]);
  });

  it('prefixes longer than maxPrefix are filtered exactly', async () => {
    const trie = await TopKTrie.buildFrom(items, 10, 4);
    expect(trie.lookup('iphone 17 p').map((s) => s.query)).toEqual([
      'iphone 17 pro max case',
    ]);
  });

  it('normalizes queries consistently for logging and lookup', () => {
    expect(normalizeQuery('  iPhone   17\tPRO ')).toBe('iphone 17 pro');
  });
});
