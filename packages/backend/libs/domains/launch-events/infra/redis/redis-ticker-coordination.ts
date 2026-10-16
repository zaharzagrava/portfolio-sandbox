import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { holdLease } from '@app/infrastructure/redis/lease';
import {
  AGGREGATION_MARKER_TTL_SEC,
  TICKER_LEASE_MS,
} from '../../domain/live-constants';
import {
  aggregationMarkerKey,
  statsMarkerKey,
  tickerLeaseKey,
} from '../../domain/live-keys';
import type { TickerCoordination } from '../../domain/live-ports';

const RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Who publishes a stream's statistics and which second was already published or aggregated (once per second, FR-030). */
@Injectable()
export class RedisTickerCoordination implements TickerCoordination {
  constructor(private readonly redis: RedisService) {}

  holdLease(streamId: string, me: string): Promise<boolean> {
    return holdLease(this.redis, tickerLeaseKey(streamId), me, TICKER_LEASE_MS);
  }

  async releaseLease(streamId: string, me: string): Promise<void> {
    await this.redis.client.eval(
      RELEASE_IF_OWNER,
      1,
      tickerLeaseKey(streamId),
      me,
    );
  }

  async claimStats(streamId: string, second: number): Promise<boolean> {
    return this.mark(statsMarkerKey(streamId, second));
  }

  async claimAggregation(streamId: string, second: number): Promise<boolean> {
    return this.mark(aggregationMarkerKey(streamId, second));
  }

  async releaseAggregation(streamId: string, second: number): Promise<void> {
    await this.redis.client.del(aggregationMarkerKey(streamId, second));
  }

  private async mark(key: string): Promise<boolean> {
    const set = await this.redis.client.set(
      key,
      '1',
      'EX',
      AGGREGATION_MARKER_TTL_SEC,
      'NX',
    );
    return set === 'OK';
  }
}
