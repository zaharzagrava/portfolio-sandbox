import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopFacts, ShopStatusCache } from '../domain/ports';

export const SHOP_STATUS_PREFIX = 'apishop:status:';
const STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED'];

@Injectable()
export class RedisShopStatusCache extends ShopStatusCache {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async get(shopId: string): Promise<ShopFacts['status'] | null> {
    const value = await this.redis.client.get(`${SHOP_STATUS_PREFIX}${shopId}`);
    return value && STATUSES.includes(value)
      ? (value as ShopFacts['status'])
      : null;
  }

  async put(
    shopId: string,
    status: ShopFacts['status'],
    ttlSec: number,
  ): Promise<void> {
    await this.redis.client.set(
      `${SHOP_STATUS_PREFIX}${shopId}`,
      status,
      'EX',
      ttlSec,
    );
  }

  async invalidate(shopId: string): Promise<void> {
    await this.redis.client.del(`${SHOP_STATUS_PREFIX}${shopId}`);
  }
}
