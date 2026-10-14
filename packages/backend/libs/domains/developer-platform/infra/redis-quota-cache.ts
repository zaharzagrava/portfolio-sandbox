import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { QuotaAnswer, QuotaCache } from '../domain/ports';

export const QUOTA_PREFIX = 'apiquota:';

@Injectable()
export class RedisQuotaCache extends QuotaCache {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async get(shopId: string): Promise<QuotaAnswer | null> {
    const raw = await this.redis.client.get(`${QUOTA_PREFIX}${shopId}`);
    return raw ? (JSON.parse(raw) as QuotaAnswer) : null;
  }

  async put(
    shopId: string,
    answer: QuotaAnswer,
    ttlSec: number,
  ): Promise<void> {
    await this.redis.client.set(
      `${QUOTA_PREFIX}${shopId}`,
      JSON.stringify(answer),
      'EX',
      ttlSec,
    );
  }
}
