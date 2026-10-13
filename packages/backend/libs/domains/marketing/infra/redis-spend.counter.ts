import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SpendCounter } from '../domain/ads-ports';
import { STORE_TIMEOUT_MS } from '../domain/ads-constants';
import { withDeadline } from './ads-timeout';

export const spendKey = (campaignId: string, day: string) =>
  `adspend:{${campaignId}}:${day}`;

const INCR_WINDOW = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n`;

/**
 * Counted clicks per campaign per UTC day: a pacing hint for serving, never a charge (R-6). Counts clicks, not money, so
 * the click path never reads Postgres and the token never carries a price. Every key has a 2-day TTL. A read slower than
 * 100 ms or a failing store throws: serving then answers an empty list (FR-015). Owner: `marketing` (S36).
 */
@Injectable()
export class RedisSpendCounter implements SpendCounter {
  constructor(private readonly redis: RedisService) {}

  async readMany(
    campaignIds: string[],
    day: string,
  ): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const values = await withDeadline('spend-counters', STORE_TIMEOUT_MS, () =>
      // one GET per key: the hash tags differ, so a multi-key command would be refused by a clustered Redis
      Promise.all(
        campaignIds.map((id) => this.redis.client.get(spendKey(id, day))),
      ),
    );
    return new Map(campaignIds.map((id, i) => [id, Number(values[i] ?? 0)]));
  }

  async increment(campaignId: string, day: string): Promise<void> {
    await withDeadline('spend-counters', STORE_TIMEOUT_MS, () =>
      this.redis.client.eval(
        INCR_WINDOW,
        1,
        spendKey(campaignId, day),
        2 * 86_400,
      ),
    );
  }
}
