import * as fc from 'fast-check';
import type { RedisService } from '@app/infrastructure/redis/redis.service';
import { InvalidCacheOptions } from './cache.errors';
import { MAX_BLOOM_ADD_BATCH, RedisBloomFilter } from './bloom-filter';

const noStore = {} as RedisService; // sizing and hashing never touch the store

const filter = (n: number, p?: number) =>
  new RedisBloomFilter(noStore, 'bloom:test', n, p);

describe('Bloom filter sizing and hashing', () => {
  it.each([
    [1_000, 0.01, 9_586, 7],
    [10_000, 0.01, 95_851, 7],
    [1_000, 0.001, 14_378, 10],
    [100, 0.05, 624, 4],
    [1, 0.5, 2, 1],
  ])('S52 AS-27: (n=%s, p=%s) → %s bits, %s hashes', (n, p, bits, hashes) => {
    const f = filter(n, p);
    expect(f.bits).toBe(bits);
    expect(f.hashes).toBe(hashes);
  });

  it('S52 AS-27: 100 million items at 1 % need about 958.5 million bits (≈ 114 MiB)', () => {
    const f = filter(100_000_000, 0.01);
    expect(f.bits).toBeGreaterThan(958_000_000);
    expect(f.bits).toBeLessThan(959_000_000);
    expect(f.bits / 8 / 1024 / 1024).toBeCloseTo(114.3, 0);
  });

  it('S52 AS-27: the false-positive rate defaults to 1 %', () => {
    expect(filter(1_000).bits).toBe(9_586);
  });

  it.each([
    ['n = 0', 0, 0.01],
    ['negative n', -5, 0.01],
    ['fractional n', 10.5, 0.01],
    ['NaN n', NaN, 0.01],
    ['p = 0', 100, 0],
    ['negative p', 100, -0.1],
    ['p = 1', 100, 1],
    ['p above 1', 100, 1.5],
    ['NaN p', 100, NaN],
    ['more than 2^32 bits', 1_000_000_000, 0.0001],
  ])('S52 AS-27: %s is rejected before any store call', (_name, n, p) => {
    expect(() => filter(n, p)).toThrow(InvalidCacheOptions);
  });

  it('S52 AS-27: the largest filter that fits 2^32 bits is accepted', () => {
    expect(() => filter(447_000_000, 0.01)).not.toThrow(); // 4.28e9 bits
    expect(filter(447_000_000, 0.01).bits).toBeLessThanOrEqual(2 ** 32);
  });

  it('S52 AS-27: add refuses a batch above the bound', async () => {
    const f = filter(1_000, 0.01);
    const items = Array.from(
      { length: MAX_BLOOM_ADD_BATCH + 1 },
      (_, i) => `i${i}`,
    );
    await expect(f.add(items)).rejects.toBeInstanceOf(InvalidCacheOptions);
  });

  it('S52 AS-27: every hash position is an integer in [0, bits) and below 2^32', () => {
    const f = filter(10_000, 0.01);
    fc.assert(
      fc.property(fc.string(), (item) => {
        const positions = f.positions(item);
        expect(positions).toHaveLength(f.hashes);
        return positions.every(
          (pos) =>
            Number.isInteger(pos) && pos >= 0 && pos < f.bits && pos < 2 ** 32,
        );
      }),
    );
  });

  it('S52 AS-27: positions are deterministic per item', () => {
    const f = filter(1_000, 0.01);
    expect(f.positions('abc')).toEqual(f.positions('abc'));
    expect(f.positions('abc')).not.toEqual(f.positions('abd'));
  });
});
