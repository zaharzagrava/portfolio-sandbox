import { InvalidCacheOptions } from './cache.errors';
import { buildCacheControl, CachePolicy } from './cache-control';

describe('Cache-Control builder', () => {
  it.each<[string, CachePolicy, string]>([
    [
      'the full public policy',
      {
        visibility: 'public',
        maxAgeSec: 60,
        sMaxAgeSec: 300,
        staleWhileRevalidateSec: 86_400,
        staleIfErrorSec: 3_600,
      },
      'public, max-age=60, s-maxage=300, stale-while-revalidate=86400, stale-if-error=3600',
    ],
    [
      'private no-store',
      { visibility: 'private', noStore: true },
      'private, no-store',
    ],
    ['no-store alone', { noStore: true }, 'no-store'],
    [
      'public max-age',
      { visibility: 'public', maxAgeSec: 0 },
      'public, max-age=0',
    ],
    [
      'private max-age',
      { visibility: 'private', maxAgeSec: 30 },
      'private, max-age=30',
    ],
    [
      'no-cache with revalidation',
      { noCache: true, mustRevalidate: true },
      'no-cache, must-revalidate',
    ],
    [
      'immutable assets',
      { visibility: 'public', maxAgeSec: 31_536_000, immutable: true },
      'public, max-age=31536000, immutable',
    ],
    [
      's-maxage on a public response',
      { visibility: 'public', sMaxAgeSec: 120 },
      'public, s-maxage=120',
    ],
  ])('S52 AS-70: %s → %s', (_name, policy, expected) => {
    expect(buildCacheControl(policy)).toBe(expected);
  });

  it.each<[string, CachePolicy]>([
    ['a negative max-age', { visibility: 'public', maxAgeSec: -1 }],
    ['a fractional max-age', { visibility: 'public', maxAgeSec: 1.5 }],
    ['a NaN duration', { visibility: 'public', maxAgeSec: NaN }],
    [
      'an unsafe duration',
      { visibility: 'public', maxAgeSec: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['a negative stale-while-revalidate', { staleWhileRevalidateSec: -5 }],
    ['a fractional stale-if-error', { staleIfErrorSec: 0.5 }],
    ['s-maxage with private', { visibility: 'private', sMaxAgeSec: 60 }],
    ['no-store with max-age', { noStore: true, maxAgeSec: 60 }],
    ['no-store with s-maxage', { noStore: true, sMaxAgeSec: 60 }],
    [
      'no-store with stale-while-revalidate',
      { noStore: true, staleWhileRevalidateSec: 60 },
    ],
    ['no-store with stale-if-error', { noStore: true, staleIfErrorSec: 60 }],
    ['no-store with no-cache', { noStore: true, noCache: true }],
    ['an unknown visibility', { visibility: 'shared' as 'public' }],
    ['an empty policy', {}],
  ])('S52 AS-70: %s is rejected', (_name, policy) => {
    expect(() => buildCacheControl(policy)).toThrow(InvalidCacheOptions);
  });
});
