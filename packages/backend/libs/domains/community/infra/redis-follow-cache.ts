import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { feedUnavailable } from '../domain/feed-errors';
import {
  followedCelebritiesKey,
  timelineCompleteKey,
} from '../domain/feed-keys';
import {
  FEED_REDIS_CLIENT,
  type FollowCacheInvalidator,
  type LegacyKeyCleaner,
} from '../domain/ports';

/** "Timeline complete" and the followed-celebrity list go stale on a follow or an unfollow (A9, AS-36). */
@Injectable()
export class RedisFollowCache implements FollowCacheInvalidator {
  private readonly logger = new Logger(RedisFollowCache.name);

  constructor(@Inject(FEED_REDIS_CLIENT) private readonly redis: Redis) {}

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(
        timelineCompleteKey(userId),
        followedCelebritiesKey(userId),
      );
    } catch (error) {
      this.logger.warn(
        `cache invalidation failed cause=${(error as Error).name}`,
      );
      throw feedUnavailable();
    }
  }
}

const LEGACY_DONE_KEY = 'fd:legacy-keys-removed';
/** Long enough that the marker outlives the migration window, short enough to keep every key expiring (III.9). */
const LEGACY_DONE_TTL_SECONDS = 35 * 86_400;

/** One-off removal of the previous implementation's unprefixed keys, by explicit name (`UNLINK`, never `KEYS`/`SCAN`). */
@Injectable()
export class RedisLegacyKeyCleaner implements LegacyKeyCleaner {
  constructor(@Inject(FEED_REDIS_CLIENT) private readonly redis: Redis) {}

  async isDone(): Promise<boolean> {
    return (await this.redis.exists(LEGACY_DONE_KEY)) === 1;
  }

  async unlink(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.unlink(key); // one key per command: the keys hash to different slots
    await pipeline.exec();
  }

  async markDone(): Promise<void> {
    await this.redis.set(LEGACY_DONE_KEY, '1', 'EX', LEGACY_DONE_TTL_SECONDS);
  }
}
