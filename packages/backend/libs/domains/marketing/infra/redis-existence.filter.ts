import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RedisBloomFilter } from '@app/infrastructure/cache/bloom-filter';
import type { ExistenceFilter, FilterAnswer } from '../domain/ports';
import { withTimeout } from './timeout';

export const FILTER_KEY = 'share-links:bloom';
export const FILTER_READY_KEY = 'share-links:bloom:ready';
export const FILTER_LOCK_KEY = 'share-links:bloom:lock';
const REDIS_TIMEOUT_MS = 150;
/** A write must not be lost to a busy Redis (the first SETBIT of a cold 12 MB key allocates it): writes get a longer budget than reads. */
const REDIS_WRITE_TIMEOUT_MS = 1_000;
const LOCK_TTL_MS = 10 * 60_000;
const ADD_BATCH = 5_000;

/**
 * Existence filter over the codes (100M entries, 1% false positives; owner `marketing`, S37 G9). It is trusted to
 * say "absent" only while the *ready* marker exists, which the rebuild job sets last; with no marker, or when Redis
 * does not answer, lookups bypass it (`bypassed`), so a lost filter costs store reads but never a wrong `404`.
 */
@Injectable()
export class RedisExistenceFilter implements ExistenceFilter {
  private readonly bloom: RedisBloomFilter;

  constructor(private readonly redis: RedisService) {
    this.bloom = new RedisBloomFilter(redis, FILTER_KEY, 100_000_000, 0.01);
  }

  async check(code: string): Promise<FilterAnswer> {
    try {
      const results = await withTimeout('link-filter', REDIS_TIMEOUT_MS, () => {
        const pipeline = this.redis.client.pipeline();
        pipeline.exists(FILTER_READY_KEY);
        for (const pos of this.bloom.positions(code))
          pipeline.getbit(FILTER_KEY, pos);
        return pipeline.exec();
      });
      const replies = results ?? [];
      for (const [error] of replies) if (error) return 'bypassed';
      const [[, ready], ...bits] = replies;
      if (ready !== 1) return 'bypassed';
      return bits.every(([, bit]) => bit === 1) ? 'maybe' : 'absent';
    } catch {
      return 'bypassed';
    }
  }

  /** Sets the code's bits in one pipeline; a failed reply is a failure (the link must not be written without its entry). */
  async add(code: string): Promise<void> {
    await withTimeout('link-filter', REDIS_WRITE_TIMEOUT_MS, () =>
      this.setBits([code]),
    );
  }

  async addMany(codes: string[]): Promise<void> {
    for (let i = 0; i < codes.length; i += ADD_BATCH)
      await this.setBits(codes.slice(i, i + ADD_BATCH));
  }

  private async setBits(codes: string[]): Promise<void> {
    if (codes.length === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const code of codes)
      for (const pos of this.bloom.positions(code))
        pipeline.setbit(FILTER_KEY, pos, 1);
    for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;
  }

  async tryLockRebuild(): Promise<boolean> {
    const reply = await withTimeout('link-filter', REDIS_TIMEOUT_MS, () =>
      this.redis.client.set(FILTER_LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'),
    );
    return reply === 'OK';
  }

  async unlockRebuild(): Promise<void> {
    await withTimeout('link-filter', REDIS_TIMEOUT_MS, () =>
      this.redis.client.del(FILTER_LOCK_KEY),
    );
  }

  async markReady(): Promise<void> {
    await withTimeout('link-filter', REDIS_TIMEOUT_MS, () =>
      this.redis.client.set(FILTER_READY_KEY, '1'),
    );
  }

  async clearReady(): Promise<void> {
    await withTimeout('link-filter', REDIS_TIMEOUT_MS, () =>
      this.redis.client.del(FILTER_READY_KEY),
    );
  }
}
