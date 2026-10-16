import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { QuotaStore } from '../../domain/ports';
import { QUOTA_CLAIM, QUOTA_CREDIT } from './lua';

const quotaKey = (eventId: string, userId: string) =>
  `qt:{${eventId}}:${userId}`;

/** Per-buyer count of held plus booked seats: a cache of the truth, with an expiry, rebuilt when missing (FR-028). */
@Injectable()
export class RedisQuotaStore implements QuotaStore {
  constructor(private readonly redis: RedisService) {}

  async claim(
    eventId: string,
    userId: string,
    count: number,
    limit: number,
    ttlSec: number,
  ) {
    const [state, used] = (await this.redis.client.eval(
      QUOTA_CLAIM,
      1,
      quotaKey(eventId, userId),
      count,
      limit,
      ttlSec,
    )) as [number, number];
    if (state < 0) return 'missing' as const;
    return { ok: state === 1, used };
  }

  async seed(
    eventId: string,
    userId: string,
    used: number,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.client.set(
      quotaKey(eventId, userId),
      used,
      'EX',
      ttlSec,
      'NX',
    );
  }

  async credit(eventId: string, userId: string, count: number): Promise<void> {
    await this.redis.client.eval(
      QUOTA_CREDIT,
      1,
      quotaKey(eventId, userId),
      count,
    );
  }
}
