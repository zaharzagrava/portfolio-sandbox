import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopFunctionsConfig } from '../application/shop-functions.config';
import type { MemoCache } from '../domain/ports';

/**
 * Memoised per-line discount vectors, keyed `shopfn:memo:{functionId}:{version}:{sha256(canonical input)}` by the
 * caller (S45 FR-031). 60 s TTL; failures are never stored; a corrupt entry is a miss.
 */
@Injectable()
export class RedisMemoCache implements MemoCache {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ShopFunctionsConfig,
  ) {}

  async get(key: string) {
    const raw = await this.redis.client.get(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((n) => Number.isInteger(n) && n >= 0)
      )
        return parsed as number[];
    } catch {
      // corrupt entry: a miss
    }
    return null;
  }

  async set(key: string, discounts: number[]) {
    await this.redis.client.set(
      key,
      JSON.stringify(discounts),
      'EX',
      this.config.cacheTtlSec,
    );
  }
}
