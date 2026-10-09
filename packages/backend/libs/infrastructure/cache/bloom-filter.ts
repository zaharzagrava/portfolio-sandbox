import { createHash } from 'node:crypto';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheUnavailable, InvalidCacheOptions } from './cache.errors';
import { cacheMetrics } from './cache-metrics';
import { sharedStoreGuard } from './shared-guard';
import type { StoreGuard } from './store-guard';

/** A filter cannot address more than 2^32 bits (the position is a 32-bit offset). */
export const MAX_BLOOM_BITS = 2 ** 32;
/** Items per `add` call; callers with more split their batches (one pipeline round trip each). */
export const MAX_BLOOM_ADD_BATCH = 10_000;

/**
 * Bloom filter on a Redis bitmap (no RedisBloom module needed): "definitely
 * not present" answers in O(k) without touching the database. Sized from the
 * expected item count n and false-positive rate p:
 *   m = ⌈-n·ln(p) / (ln 2)²⌉   bits,   k = max(1, round((m/n)·ln 2))   hash functions.
 * 100M items at 1% ≈ 114 MiB of bits. Used where membership checks are
 * genuinely hot (SD-08 unknown short codes, SD-35 seen URLs).
 *
 * It never lies in one direction: no false negatives. When the store cannot answer, `mightContain` returns `true`
 * (absence cannot be proven, so a real item is never blocked) and `add` rejects with `CacheUnavailable`.
 */
export class RedisBloomFilter {
  readonly bits: number;
  readonly hashes: number;
  private readonly guard: StoreGuard;

  constructor(
    private readonly redis: RedisService,
    private readonly key: string,
    expectedItems: number,
    falsePositiveRate = 0.01,
    guard?: StoreGuard,
  ) {
    if (!Number.isInteger(expectedItems) || expectedItems < 1)
      throw new InvalidCacheOptions(
        'expectedItems',
        'must be an integer of at least 1',
      );
    if (
      typeof falsePositiveRate !== 'number' ||
      !(falsePositiveRate > 0 && falsePositiveRate < 1)
    )
      throw new InvalidCacheOptions(
        'falsePositiveRate',
        'must be between 0 and 1, exclusive',
      );
    const bits = Math.ceil(
      (-expectedItems * Math.log(falsePositiveRate)) / Math.LN2 ** 2,
    );
    if (bits > MAX_BLOOM_BITS)
      throw new InvalidCacheOptions(
        'expectedItems',
        `would need ${bits} bits; the limit is 2^32`,
      );
    this.bits = bits;
    this.hashes = Math.max(1, Math.round((bits / expectedItems) * Math.LN2));
    this.guard = guard ?? sharedStoreGuard();
  }

  /** Kirsch–Mitzenmacher double hashing: k positions from two 64-bit hashes. */
  positions(item: string): number[] {
    const digest = createHash('sha256').update(item).digest();
    const h1 = digest.readBigUInt64BE(0);
    const h2 = digest.readBigUInt64BE(8) | 1n;
    const m = BigInt(this.bits);
    return Array.from({ length: this.hashes }, (_, i) => {
      const position = (h1 + BigInt(i) * h2) % m;
      if (position >= BigInt(MAX_BLOOM_BITS))
        throw new Error('bloom position beyond 2^32'); // unreachable: m <= 2^32
      return Number(position);
    });
  }

  /** Idempotent: setting a bit twice changes nothing. */
  async add(items: string[]): Promise<void> {
    if (items.length > MAX_BLOOM_ADD_BATCH)
      throw new InvalidCacheOptions(
        'items',
        `at most ${MAX_BLOOM_ADD_BATCH} items per add`,
      );
    if (items.length === 0) return;
    await this.guard.run(async () => {
      const pipeline = this.redis.client.pipeline();
      for (const item of items)
        for (const pos of this.positions(item))
          pipeline.setbit(this.key, pos, 1);
      const replies = (await pipeline.exec()) ?? [];
      for (const [error] of replies) if (error) throw error;
    });
  }

  /** `false` only when the item was definitely never added; `true` also when the store cannot answer. */
  async mightContain(item: string): Promise<boolean> {
    try {
      return await this.guard.run(async () => {
        const pipeline = this.redis.client.pipeline();
        for (const pos of this.positions(item)) pipeline.getbit(this.key, pos);
        const results = (await pipeline.exec()) ?? [];
        for (const [error] of results) if (error) throw error;
        return results.every(([, bit]) => bit === 1);
      });
    } catch (error) {
      if (!(error instanceof CacheUnavailable)) throw error;
      cacheMetrics().bloomDegraded.add(1);
      return true;
    }
  }
}
