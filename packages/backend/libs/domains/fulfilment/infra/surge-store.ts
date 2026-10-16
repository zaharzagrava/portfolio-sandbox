import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SurgeStore } from '../domain/delivery-ports';
import { errorText, logDelivery } from '../application/delivery-log';
import { demandKey, surgeKey } from './courier-keys';

/** Every Redis call of the store gives up after this long: a fee read must never hold a request. */
const STORE_TIMEOUT_MS = 500;
const MINUTE_MS = 60_000;
/** Demand window: ten one-minute buckets ending with the minute of `now`. */
const DEMAND_WINDOW_MINUTES = 10;
/** A bucket outlives the window by one minute. */
const DEMAND_BUCKET_TTL_S = (DEMAND_WINDOW_MINUTES + 1) * 60;
const INTEGER = /^\d+$/;

const withTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('surge store timed out')),
        STORE_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The surge map and the demand counters in Redis (S20 R-7, A5, A24): one hash per city (`surge:{city}`, cell ->
 * hundredths) replaced as a whole with a 180 s expiry, so a dead computation falls back to 1.00 by itself; demand is a
 * hash per city and minute (`demand:{city}:<minute>`, cell -> requests) incremented at request time and summed over the
 * last ten minutes. Values are integers parsed with a strict pattern - no `Number(x ?? 1)` float path reaches a fee.
 * Reads are best effort: a store fault reads as "no surge" (1.00) and is logged; the caller's request goes on.
 */
@Injectable()
export class RedisSurgeStore implements SurgeStore {
  private readonly logger = new Logger(RedisSurgeStore.name);

  constructor(private readonly redis: RedisService) {}

  async read(city: string, cell: string): Promise<number | null> {
    try {
      const raw = await withTimeout(
        this.redis.client.hget(surgeKey(city), cell),
      );
      return raw !== null && INTEGER.test(raw) ? Number(raw) : null;
    } catch (error) {
      logDelivery(this.logger, 'warn', 'surge.read_failed', {
        city,
        error: errorText(error),
      });
      return null;
    }
  }

  async write(
    city: string,
    surgeByCell: ReadonlyMap<string, number>,
    ttlSeconds: number,
  ): Promise<void> {
    const key = surgeKey(city);
    const pipeline = this.redis.client.multi().del(key);
    if (surgeByCell.size > 0) {
      const fields: Record<string, string> = {};
      for (const [cell, hundredths] of surgeByCell) {
        if (!Number.isInteger(hundredths))
          throw new RangeError('surge must be an integer in hundredths');
        fields[cell] = String(hundredths);
      }
      pipeline.hset(key, fields).expire(key, ttlSeconds);
    }
    await pipeline.exec();
  }

  async recordDemand(city: string, cell: string, now: number): Promise<void> {
    const key = demandKey(city, Math.floor(now / MINUTE_MS));
    await this.redis.client
      .multi()
      .hincrby(key, cell, 1)
      .expire(key, DEMAND_BUCKET_TTL_S)
      .exec();
  }

  async demandByCell(city: string, now: number): Promise<Map<string, number>> {
    const current = Math.floor(now / MINUTE_MS);
    const pipeline = this.redis.client.multi();
    for (let i = 0; i < DEMAND_WINDOW_MINUTES; i++)
      pipeline.hgetall(demandKey(city, current - i));
    const replies = (await pipeline.exec()) ?? [];
    const total = new Map<string, number>();
    for (const [error, bucket] of replies) {
      if (error) throw error;
      for (const [cell, count] of Object.entries(
        (bucket ?? {}) as Record<string, string>,
      ))
        if (INTEGER.test(count))
          total.set(cell, (total.get(cell) ?? 0) + Number(count));
    }
    return total;
  }
}
