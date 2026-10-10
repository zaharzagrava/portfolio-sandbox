import type { RedisService } from '@app/infrastructure/redis/redis.service';
import { InvalidCacheOptions, InvalidIncrement } from './cache.errors';
import { WriteBehindCounter } from './write-behind-counter';

/** Input rules are checked before the store is touched: this stand-in throws if anything reaches it. */
const untouchedStore = new Proxy(
  {},
  {
    get() {
      throw new Error('the store must not be touched');
    },
  },
) as unknown as RedisService;

const counter = () => new WriteBehindCounter(untouchedStore, 'views');

describe('WriteBehindCounter input rules', () => {
  it.each([
    ['zero', 0],
    ['negative zero', -0],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['above the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['below the safe range', -(Number.MAX_SAFE_INTEGER + 1)],
    ['a string', '3' as unknown as number],
    ['null', null as unknown as number],
  ])('S52 AS-53: by = %s is an InvalidIncrement', async (_name, by) => {
    await expect(counter().increment('a', by)).rejects.toBeInstanceOf(
      InvalidIncrement,
    );
  });

  it.each([
    ['empty', ''],
    ['257 bytes', 'x'.repeat(257)],
    ['129 two-byte characters', 'é'.repeat(129)],
    ['not a string', 42 as unknown as string],
    ['undefined', undefined as unknown as string],
  ])(
    'S52 AS-53: a member that is %s is an InvalidIncrement',
    async (_name, member) => {
      await expect(counter().increment(member, 1)).rejects.toBeInstanceOf(
        InvalidIncrement,
      );
    },
  );

  it.each([
    ['a lowercase name', 'views'],
    ['with digits and hyphens', 'product-views-2'],
    ['64 characters', `a${'b'.repeat(63)}`],
  ])('S52 AS-53: a counter name %s is accepted', (_name, name) => {
    expect(() => new WriteBehindCounter(untouchedStore, name)).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Views'],
    ['starting with a digit', '1views'],
    ['starting with a hyphen', '-views'],
    ['with an underscore', 'my_views'],
    ['with a colon', 'a:b'],
    ['with a brace', 'a{b}'],
    ['65 characters', `a${'b'.repeat(64)}`],
  ])(
    'S52 AS-53: a counter name %s throws InvalidCacheOptions at construction',
    (_name, name) => {
      expect(() => new WriteBehindCounter(untouchedStore, name)).toThrow(
        InvalidCacheOptions,
      );
    },
  );
});
