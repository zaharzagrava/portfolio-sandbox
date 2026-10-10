import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  AuthzCache,
  AuthzCacheEntry,
  AuthzCacheRead,
} from '../domain/ports';

export const AUTHZ_TTL_MS = 15_000;
export const AUTHZ_NEGATIVE_TTL_MS = 10_000;

const key = (shopId: string, userId: string) => `authz:${shopId}:${userId}`;
const indexKey = (shopId: string) => `authz-index:${shopId}`;

interface Stored {
  /** `null` = cached "not a member". */
  v: AuthzCacheEntry | null;
  /** Write time from the injected clock: the entry is stale after its TTL even if the store still holds it. */
  at: number;
}

/**
 * Shared-store authorization cache (FR-015): one Redis, no per-process layer, 15 s positive / 10 s negative. Never the
 * source of truth: failures answer `down` (the caller reads the database) and never throw.
 */
@Injectable()
export class RedisAuthzCache implements AuthzCache {
  private readonly logger = new Logger(RedisAuthzCache.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(shopId: string, userId: string): Promise<AuthzCacheRead> {
    try {
      const raw = await this.redis.client.get(key(shopId, userId));
      if (raw === null) return { state: 'miss' };
      const stored = JSON.parse(raw) as Stored;
      const ttl = stored.v ? AUTHZ_TTL_MS : AUTHZ_NEGATIVE_TTL_MS;
      if (this.clock.nowMs() - stored.at >= ttl) return { state: 'miss' };
      return { state: 'hit', value: stored.v };
    } catch (error) {
      this.logger.warn(`authz cache read failed: ${(error as Error).message}`);
      return { state: 'down' };
    }
  }

  async set(
    shopId: string,
    userId: string,
    value: AuthzCacheEntry | null,
  ): Promise<void> {
    try {
      const ttl = value ? AUTHZ_TTL_MS : AUTHZ_NEGATIVE_TTL_MS;
      const stored: Stored = { v: value, at: this.clock.nowMs() };
      await this.redis.client
        .multi()
        .set(key(shopId, userId), JSON.stringify(stored), 'PX', ttl)
        .sadd(indexKey(shopId), userId)
        .pexpire(indexKey(shopId), AUTHZ_TTL_MS * 2)
        .exec();
    } catch (error) {
      this.logger.warn(`authz cache write failed: ${(error as Error).message}`);
    }
  }

  async delete(shopId: string, userId?: string): Promise<void> {
    try {
      if (userId) {
        await this.redis.client.del(key(shopId, userId));
        await this.redis.client.srem(indexKey(shopId), userId);
        return;
      }
      const users = await this.redis.client.smembers(indexKey(shopId));
      if (users.length > 0)
        await this.redis.client.del(...users.map((u) => key(shopId, u)));
      await this.redis.client.del(indexKey(shopId));
    } catch (error) {
      this.logger.warn(
        `authz cache delete failed: ${(error as Error).message}`,
      );
    }
  }
}
