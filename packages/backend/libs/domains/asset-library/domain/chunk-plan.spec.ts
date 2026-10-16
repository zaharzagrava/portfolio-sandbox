import { occurrencesOf, referenceDelta } from './chunk-plan';

describe('S31 chunk reference planning', () => {
  it('S31 AS-44: a hash listed twice counts twice', () => {
    expect(occurrencesOf(['a', 'b', 'a', 'c', 'a'])).toEqual([
      { hash: 'a', occurrences: 3 },
      { hash: 'b', occurrences: 1 },
      { hash: 'c', occurrences: 1 },
    ]);
  });

  it('S31 AS-44: rows come sorted by hash, so concurrent writers lock in one order', () => {
    expect(occurrencesOf(['z', 'm', 'a']).map((r) => r.hash)).toEqual([
      'a',
      'm',
      'z',
    ]);
  });

  it('S31 AS-44: an empty file references nothing', () => {
    expect(occurrencesOf([])).toEqual([]);
  });

  it('S31 AS-44: the delta of a swap raises new hashes and lowers dropped ones', () => {
    const delta = referenceDelta(['a', 'a', 'b'], ['a', 'c', 'c']);
    expect(delta).toEqual([
      { hash: 'a', delta: -1 },
      { hash: 'b', delta: -1 },
      { hash: 'c', delta: 2 },
    ]);
  });

  it('S31 AS-44: identical lists have no delta', () => {
    expect(referenceDelta(['a', 'b'], ['b', 'a'])).toEqual([]);
  });
});
