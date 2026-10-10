import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';

/** Redis key of a cached upstream body: `bff:cache:{endpoint}:{sha256(url)}`. */
export const cacheKey = (endpoint: string, url: string): string =>
  `bff:cache:${endpoint}:${createHash('sha256').update(url).digest('hex')}`;

interface Entry {
  expiresAt: number;
  body: unknown;
}

/**
 * Cache of validated, caller-independent upstream bodies (S48 FR-011). The entry is the *validated body* and is
 * validated again on read, so a poisoned entry cannot bypass the contract. Expiry is checked against the injected
 * clock; the Redis TTL is only the backstop. A cache failure is never a request failure.
 */
@Injectable()
export class ShapedCache {
  private readonly logger = new Logger(ShapedCache.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as Entry;
      if (
        typeof entry.expiresAt !== 'number' ||
        entry.expiresAt <= this.clock.nowMs()
      )
        return undefined;
      const parsed = schema.safeParse(entry.body);
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      this.logger.warn(`cache read failed (${(error as Error).name})`);
      return undefined;
    }
  }

  async set(key: string, body: unknown, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    try {
      const entry: Entry = { expiresAt: this.clock.nowMs() + ttlMs, body };
      // backstop only: the clock decides freshness, Redis just forgets the key eventually
      await this.redis.client.set(
        key,
        JSON.stringify(entry),
        'PX',
        ttlMs + 60_000,
      );
    } catch (error) {
      this.logger.warn(`cache write failed (${(error as Error).name})`);
    }
  }
}
