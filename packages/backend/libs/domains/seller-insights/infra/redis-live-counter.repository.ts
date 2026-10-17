import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { BoardStoreUnavailableError } from '../domain/errors';
import type {
  LiveBucket,
  LiveCounterRepository,
  LiveIncrement,
  LiveOutcome,
} from '../domain/ports';
import { INSIGHTS_REDIS } from './redis-board.repository';
import {
  LIVE_BUCKET_TTL_SEC,
  LIVE_MARK_TTL_SEC,
  LIVE_SHOP_PATTERN,
  liveBucketKey,
  liveMarkKey,
} from './redis-keys';

export const LIVE_WINDOW_SECONDS = 60;

/**
 * KEYS[1] the per-event mark, KEYS[2] the second's bucket; ARGV: mark TTL, bucket TTL, checkouts, orders, units, revenue.
 * The mark and the increments are one step: a failed attempt leaves no mark, so the redelivery counts (S40 FR-029).
 */
const APPLY_LIVE_SCRIPT = `
local set = redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX')
if not set then return 0 end
local fields = {'checkouts', 'orders', 'units', 'revenue'}
for i = 1, 4 do
  local n = tonumber(ARGV[2 + i])
  if n ~= 0 then redis.call('HINCRBY', KEYS[2], fields[i], n) end
end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1`;

/** Per-second counters per shop, in Redis. Events older than the window never write. */
@Injectable()
export class RedisLiveCounterRepository implements LiveCounterRepository {
  constructor(@Inject(INSIGHTS_REDIS) private readonly redis: Redis) {}

  async apply(
    eventId: string,
    kind: 'reserved' | 'paid',
    second: number,
    nowSecond: number,
    inc: LiveIncrement,
  ): Promise<LiveOutcome> {
    if (nowSecond - second >= LIVE_WINDOW_SECONDS) return 'stale';
    try {
      const applied = await this.redis.eval(
        APPLY_LIVE_SCRIPT,
        2,
        liveMarkKey(inc.shopId, eventId, kind),
        liveBucketKey(inc.shopId, second),
        LIVE_MARK_TTL_SEC,
        LIVE_BUCKET_TTL_SEC,
        inc.checkouts ?? 0,
        inc.orders ?? 0,
        inc.units ?? 0,
        inc.revenueMinor ?? 0,
      );
      return applied === 1 ? 'applied' : 'duplicate';
    } catch (error) {
      throw new BoardStoreUnavailableError(error);
    }
  }

  async window(shopId: string, endSecond: number): Promise<LiveBucket[]> {
    try {
      const pipeline = this.redis.pipeline();
      for (let s = endSecond - LIVE_WINDOW_SECONDS + 1; s <= endSecond; s++)
        pipeline.hgetall(liveBucketKey(shopId, s));
      const results = (await pipeline.exec()) ?? [];
      return results.map(([error, value]) => {
        if (error) throw error;
        const b = (value ?? {}) as Record<string, string>;
        return {
          checkouts: Number(b.checkouts ?? 0),
          orders: Number(b.orders ?? 0),
          units: Number(b.units ?? 0),
          revenue: Number(b.revenue ?? 0),
        };
      });
    } catch (error) {
      throw new BoardStoreUnavailableError(error);
    }
  }

  async removeShop(shopId: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        LIVE_SHOP_PATTERN(shopId),
        'COUNT',
        500,
      );
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
