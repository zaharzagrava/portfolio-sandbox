import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { ImpressionMarker } from '../domain/ads-ports';
import { MARKER_TTL_SECONDS, STORE_TIMEOUT_MS } from '../domain/ads-constants';
import { withDeadline } from './ads-timeout';

export const impressionKey = (impressionId: string) =>
  `adclick:${impressionId}`;

/**
 * The per-impression dedupe marker (FR-022): `SET NX` with a life of token life + 5 minutes. Whoever sets it owns the
 * impression, so concurrent clicks yield exactly one counted click. A store failure or a timeout beyond 100 ms throws:
 * the click service then records the click invalid `filter_unavailable` (AS-35). Owner: `marketing` (S36).
 */
@Injectable()
export class RedisImpressionMarker implements ImpressionMarker {
  constructor(private readonly redis: RedisService) {}

  async claim(impressionId: string): Promise<boolean> {
    const reply = await withDeadline('marker', STORE_TIMEOUT_MS, () =>
      this.redis.client.set(
        impressionKey(impressionId),
        '1',
        'EX',
        MARKER_TTL_SECONDS,
        'NX',
      ),
    );
    return reply === 'OK';
  }

  async release(impressionId: string): Promise<void> {
    await withDeadline('marker', STORE_TIMEOUT_MS, () =>
      this.redis.client.del(impressionKey(impressionId)),
    );
  }
}
