import {
  concurrencyKey,
  hashTag,
  slidingWindowKeys,
  tokenBucketKey,
} from './policy-keys';

const tagOf = (key: string) => /\{[^}]*\}/.exec(key)?.[0];

describe('S50 policy keys', () => {
  it('S50 AS-73: layout of every stored item', () => {
    expect(hashTag('a.b', 'user:1')).toBe('{a.b|user:1}');
    expect(tokenBucketKey('a.b', 'user:1')).toBe('rl:{a.b|user:1}:tb');
    expect(concurrencyKey('a.b', 'user:1')).toBe('rl:{a.b|user:1}:cc');
    expect(slidingWindowKeys('a.b', 'user:1', 7)).toEqual({
      current: 'rl:{a.b|user:1}:sw:7',
      previous: 'rl:{a.b|user:1}:sw:6',
    });
  });

  it('S50 AS-73: all keys of one decision share one hash tag', () => {
    const { current, previous } = slidingWindowKeys('a.b', 'ip:1.2.3.4', 99);
    expect(tagOf(current)).toBe(tagOf(previous));
    expect(tagOf(tokenBucketKey('a.b', 'ip:1.2.3.4'))).toBe(tagOf(current));
    expect(tagOf(concurrencyKey('a.b', 'ip:1.2.3.4'))).toBe(tagOf(current));
  });

  it('S50 AS-73: keys of different subjects or policies differ in the tag', () => {
    expect(tagOf(tokenBucketKey('a.b', 'user:1'))).not.toBe(
      tagOf(tokenBucketKey('a.b', 'user:2')),
    );
    expect(tagOf(tokenBucketKey('a.b', 'user:1'))).not.toBe(
      tagOf(tokenBucketKey('a.c', 'user:1')),
    );
  });

  it('S50 AS-73: every key carries the rl: prefix', () => {
    expect(tokenBucketKey('a.b', 's')).toMatch(/^rl:/);
    expect(slidingWindowKeys('a.b', 's', 1).current).toMatch(/^rl:/);
  });
});
