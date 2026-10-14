import { murmur3 } from '@app/common/core/murmur3';
import { bucketOf } from './bucket';

/** The assignment hash is shared with analytics (P0811): its reference vectors must never change. */
describe('bucketOf', () => {
  it.each([
    ['', 0],
    ['hello', 613153351],
    ['The quick brown fox jumps over the lazy dog', 0x2e4ff723],
  ])('S38 AS-15: murmur3(%j) matches the reference vector', (input, hash) => {
    expect(murmur3(input)).toBe(hash);
  });

  it.each([
    ['new-checkout', 'user-1'],
    ['new-checkout', 'user-2'],
    ['flag-a', 'shop-9'],
    ['flag-b', 'shop-9'],
  ])(
    'S38 AS-15: bucketOf(%s, %s) is murmur3(salt:unit) mod 10000',
    (salt, unit) => {
      expect(bucketOf(salt, unit)).toBe(murmur3(`${salt}:${unit}`) % 10_000);
      expect(bucketOf(salt, unit)).toBeGreaterThanOrEqual(0);
      expect(bucketOf(salt, unit)).toBeLessThan(10_000);
    },
  );

  it('S38 AS-15: pinned bucket values never change', () => {
    expect(bucketOf('new-checkout', 'user-1')).toBe(PIN.a);
    expect(bucketOf('flag-a', 'shop-9')).toBe(PIN.b);
  });
});

const PIN = { a: 631, b: 1734 };
