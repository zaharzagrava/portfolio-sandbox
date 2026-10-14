import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { VersionPinCache } from '../domain/ports';

export const VERSION_PIN_PREFIX = 'apipin:';

@Injectable()
export class RedisVersionPinCache extends VersionPinCache {
  constructor(private readonly redis: RedisService) {
    super();
  }

  get(shopId: string): Promise<string | null> {
    return this.redis.client.get(`${VERSION_PIN_PREFIX}${shopId}`);
  }

  async put(shopId: string, version: string, ttlSec: number): Promise<void> {
    await this.redis.client.set(
      `${VERSION_PIN_PREFIX}${shopId}`,
      version,
      'EX',
      ttlSec,
    );
  }

  async invalidate(shopId: string): Promise<void> {
    await this.redis.client.del(`${VERSION_PIN_PREFIX}${shopId}`);
  }
}
