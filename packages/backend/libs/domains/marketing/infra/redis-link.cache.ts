import { Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import type { LinkCache, StoredLink } from '../domain/ports';

const key = (code: string) => `link:v1:${code}`;

const FRESH_MS = 3_600_000;
const STALE_IF_ERROR_MS = 86_400_000;
const MISS_MS = 60_000;
const REDIS_TIMEOUT_MS = 150;

/**
 * Cache-aside for the redirect (S37 G10): fresh for 1 h, a stale copy is served for up to 24 h when the store fails,
 * a miss is remembered for 60 s, concurrent loads of one code share one store read, and a loader error is never
 * stored. Keys `link:v1:<code>` always carry a TTL; owner `marketing`.
 */
@Injectable()
export class RedisLinkCache implements LinkCache {
  constructor(private readonly cache: CacheService) {}

  getOrLoad(
    code: string,
    loader: () => Promise<StoredLink | null>,
  ): Promise<StoredLink | null> {
    return this.cache.getOrLoad<StoredLink>(key(code), loader, {
      ttlMs: FRESH_MS,
      staleIfErrorMs: STALE_IF_ERROR_MS,
      negativeTtlMs: MISS_MS,
      timeoutMs: REDIS_TIMEOUT_MS,
      l1: 'never',
    });
  }

  async invalidate(code: string): Promise<void> {
    await this.cache.invalidate([key(code)]);
  }
}
