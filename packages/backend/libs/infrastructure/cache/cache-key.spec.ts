import { InvalidCacheKey } from './cache.errors';
import {
  cacheKey,
  keyDigest,
  keyNamespace,
  minimumKey,
  recomputeLockKey,
  validateKey,
} from './cache-key';

describe('Cache key builder and validation', () => {
  it.each([
    [['product', 1, 'a:b', 'c'], 'product:v1:a%3Ab:c'],
    [['product', 1, 'a', 'b:c'], 'product:v1:a:b%3Ac'],
    [['product', 12, 'x'], 'product:v12:x'],
    [['shop-site', 3, 'a{b}c'], 'shop-site:v3:a%7Bb%7Dc'],
    [['product', 1, '100%'], 'product:v1:100%25'],
    [['product', 1, 'a b'], 'product:v1:a%20b'],
    [['product', 1, 'tab\there'], 'product:v1:tab%09here'],
    [['product', 1, 'line\nbreak'], 'product:v1:line%0Abreak'],
    [['product', 1, 'é'], 'product:v1:é'],
  ] as const)('S52 AS-09: cacheKey(%j) → %s', (args, expected) => {
    expect(
      cacheKey(...(args as unknown as [string, number, ...string[]])),
    ).toBe(expected);
  });

  it('S52 AS-09: parts that differ only in where the colon sits give different keys', () => {
    expect(cacheKey('product', 1, 'a:b', 'c')).not.toBe(
      cacheKey('product', 1, 'a', 'b:c'),
    );
  });

  it.each([
    ['empty namespace', ['', 1, 'a']],
    ['uppercase namespace', ['Product', 1, 'a']],
    ['namespace with colon', ['pro:duct', 1, 'a']],
    ['namespace starting with a digit', ['1abc', 1, 'a']],
    ['version zero', ['product', 0, 'a']],
    ['negative version', ['product', -1, 'a']],
    ['fractional version', ['product', 1.5, 'a']],
    ['NaN version', ['product', NaN, 'a']],
    ['empty part', ['product', 1, '']],
    ['no parts', ['product', 1]],
  ] as const)('S52 AS-09: cacheKey rejects %s', (_name, args) => {
    expect(() =>
      cacheKey(...(args as unknown as [string, number, ...string[]])),
    ).toThrow(InvalidCacheKey);
  });

  it.each([
    ['empty', ''],
    ['longer than 512 bytes', `product:${'x'.repeat(520)}`],
    ['multi-byte past 512 bytes', `product:${'é'.repeat(260)}`],
    ['whitespace', 'product:v1:a b'],
    ['newline', 'product:v1:a\nb'],
    ['control character', 'product:v1:a\u0001b'],
    ['no namespace separator', 'product'],
    ['leading colon', ':v1:a'],
    ['trailing namespace separator only', 'product:'],
    ['opening brace', 'product:v1:{a'],
    ['closing brace', 'product:v1:a}'],
  ])('S52 AS-09: validateKey rejects %s', (_name, key) => {
    expect(() => validateKey(key)).toThrow(InvalidCacheKey);
  });

  it.each([
    'product:v1:abc',
    'auth:user:v1:123e4567-e89b-12d3-a456-426614174000',
    'experiments:running',
    'launch-event:v1:42',
    `product:${'x'.repeat(504)}`,
  ])('S52 AS-09: validateKey accepts %s', (key) => {
    expect(() => validateKey(key)).not.toThrow();
  });

  it('S52 AS-09: non-string keys are rejected', () => {
    expect(() => validateKey(undefined)).toThrow(InvalidCacheKey);
    expect(() => validateKey(42)).toThrow(InvalidCacheKey);
  });

  it('S52 AS-09: two tenants never share a key and neither can forge the other', () => {
    const a = cacheKey('entitlements', 1, 'tenant-a', 'user-1');
    const b = cacheKey('entitlements', 1, 'tenant-b', 'user-1');
    expect(a).not.toBe(b);
    // A tenant id that tries to smuggle a separator stays one segment.
    const forged = cacheKey('entitlements', 1, 'tenant-a:user-1', 'x');
    expect(forged.split(':')).toHaveLength(4);
    expect(forged).not.toBe(
      cacheKey('entitlements', 1, 'tenant-a', 'user-1', 'x'),
    );
  });

  it('S52 FR-020: auxiliary records carry the entry key as their hash tag', () => {
    expect(minimumKey('product:v1:a')).toBe('{product:v1:a}:min');
    expect(recomputeLockKey('product:v1:a')).toBe('{product:v1:a}:lock');
  });

  it('S52 AS-72: the namespace is the first segment and the digest is 8 hex characters', () => {
    expect(keyNamespace('product:v1:abc')).toBe('product');
    const digest = keyDigest('product:v1:abc');
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    expect(keyDigest('product:v1:abd')).not.toBe(digest);
  });
});
