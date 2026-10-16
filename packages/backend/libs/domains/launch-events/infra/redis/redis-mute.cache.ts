import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { bannedFilledKey, bannedKey } from '../../domain/live-keys';
import type { MuteCache } from '../../domain/live-ports';

const TTL_SEC = 7 * 24 * 3600;

/**
 * Mutes of a stream as a Redis set plus a marker that says the set was filled from the durable record. Without the
 * marker an absent member means "unknown", never "not muted" (a wipe must not lift a mute, FR-024).
 */
@Injectable()
export class RedisMuteCache implements MuteCache {
  constructor(private readonly redis: RedisService) {}

  async isMuted(streamId: string, userId: string): Promise<boolean | null> {
    const [member, filled] = await Promise.all([
      this.redis.client.sismember(bannedKey(streamId), userId),
      this.redis.client.exists(bannedFilledKey(streamId)),
    ]);
    if (member === 1) return true;
    return filled === 1 ? false : null;
  }

  async fill(streamId: string, userIds: string[]): Promise<void> {
    const pipeline = this.redis.client.multi().del(bannedKey(streamId));
    if (userIds.length > 0) pipeline.sadd(bannedKey(streamId), ...userIds);
    pipeline
      .expire(bannedKey(streamId), TTL_SEC)
      .set(bannedFilledKey(streamId), '1', 'EX', TTL_SEC);
    await pipeline.exec();
  }

  async add(streamId: string, userId: string): Promise<void> {
    await this.redis.client
      .multi()
      .sadd(bannedKey(streamId), userId)
      .expire(bannedKey(streamId), TTL_SEC)
      .exec();
  }

  async remove(streamId: string, userId: string): Promise<void> {
    await this.redis.client.srem(bannedKey(streamId), userId);
  }
}
