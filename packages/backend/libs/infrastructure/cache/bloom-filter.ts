import { createHash } from 'node:crypto';
import { RedisService } from '@app/infrastructure/redis/redis.service';

/**
 * Bloom filter on a Redis bitmap (no RedisBloom module needed): "definitely
 * not present" answers in O(k) without touching the database. Sized from the
 * expected item count n and false-positive rate p:
 *   m = -n·ln(p) / (ln 2)²   bits,   k = (m/n)·ln 2   hash functions.
 * 100M items at 1% ≈ 120 MB of bits. Used where membership checks are
 * genuinely hot (SD-08 unknown short codes, SD-35 seen URLs).
 */
export class RedisBloomFilter {
  readonly bits: number;
  readonly hashes: number;

  constructor(
    private readonly redis: RedisService,
    private readonly key: string,
    expectedItems: number,
    falsePositiveRate = 0.01,
  ) {
    this.bits = Math.ceil(
      (-expectedItems * Math.log(falsePositiveRate)) / Math.LN2 ** 2,
    );
    this.hashes = Math.max(
      1,
      Math.round((this.bits / expectedItems) * Math.LN2),
    );
  }

  /** Kirsch–Mitzenmacher double hashing: k positions from two 64-bit hashes. */
  positions(item: string): number[] {
    const digest = createHash('sha256').update(item).digest();
    const h1 = digest.readBigUInt64BE(0);
    const h2 = digest.readBigUInt64BE(8) | 1n;
    const m = BigInt(this.bits);
    return Array.from({ length: this.hashes }, (_, i) =>
      Number((h1 + BigInt(i) * h2) % m),
    );
  }

  async add(items: string[]): Promise<void> {
    const pipeline = this.redis.client.pipeline();
    for (const item of items)
      for (const pos of this.positions(item)) pipeline.setbit(this.key, pos, 1);
    await pipeline.exec();
  }

  async mightContain(item: string): Promise<boolean> {
    const pipeline = this.redis.client.pipeline();
    for (const pos of this.positions(item)) pipeline.getbit(this.key, pos);
    const results = (await pipeline.exec()) ?? [];
    return results.every(([, bit]) => bit === 1);
  }
}
