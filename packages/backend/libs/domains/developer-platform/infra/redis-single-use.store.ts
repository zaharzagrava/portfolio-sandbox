import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SingleUseStore, SingleUseUnavailable } from '../domain/widget-ports';

/**
 * Hand-off markers (FR-019): one atomic `SET NX EX`. A store failure is typed so the caller fails closed (503) without
 * having consumed the token; a marker that was set is never rolled back.
 */
@Injectable()
export class RedisSingleUseStore extends SingleUseStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const reply = await this.redis.client.set(
        key,
        '1',
        'EX',
        Math.max(1, Math.ceil(ttlSeconds)),
        'NX',
      );
      return reply === 'OK';
    } catch (error) {
      throw new SingleUseUnavailable(error);
    }
  }
}
