import { sharedCacheTtlMs } from './shared-cache-policy';

describe('S48 AS-19 shared cache policy (unit)', () => {
  it.each([
    ['public, s-maxage=5', 5_000],
    ['s-maxage=5', 5_000],
    ['PUBLIC, S-MaxAge=5', 5_000],
    ['public, max-age=60, s-maxage=5', 5_000],
    ['public, max-age=7', 7_000],
    ['public, s-maxage=3600', 30_000], // ceiling
    ['public, s-maxage=30', 30_000],
    ['public, s-maxage=31', 30_000],
    ['public, s-maxage=0', 0],
    ['private, s-maxage=5', 0],
    ['no-store, s-maxage=5', 0],
    ['public, no-cache, s-maxage=5', 0],
    ['no-store', 0],
    ['private', 0],
    ['public', 0],
    ['max-age=60', 0], // not marked shared-cacheable
    ['', 0],
    [undefined, 0],
    ['s-maxage=abc', 0],
    ['s-maxage=-1', 0],
    ['s-maxage=1.5', 0],
    ['public, s-maxage=5, s-maxage=9', 0], // ambiguous: refuse
  ])('S48 AS-19: %j → %s ms', (header, ttl) => {
    expect(sharedCacheTtlMs(header, 30_000)).toBe(ttl);
  });

  it('S48 AS-19: a lower configured ceiling wins', () => {
    expect(sharedCacheTtlMs('public, s-maxage=20', 10_000)).toBe(10_000);
    expect(sharedCacheTtlMs('public, s-maxage=20', 0)).toBe(0);
  });
});
