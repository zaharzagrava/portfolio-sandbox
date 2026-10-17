import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopFunctionsConfig } from '../application/shop-functions.config';
import type { ActiveFunction, ActiveSetCache } from '../domain/ports';

const key = (shopId: string) => `shopfn:active:${shopId}`;

const isActive = (value: unknown): value is ActiveFunction => {
  const v = value as Partial<ActiveFunction> | null;
  return (
    !!v &&
    typeof v.id === 'string' &&
    typeof v.shopId === 'string' &&
    typeof v.name === 'string' &&
    Number.isInteger(v.version) &&
    typeof v.source === 'string' &&
    typeof v.sourceHash === 'string'
  );
};

/**
 * The enabled functions with an active version, per shop (S45 FR-031). Derived and never the source of truth: every key
 * has a TTL, a corrupt entry is a miss, and a change drops the key after commit. No `KEYS`/`SCAN`.
 */
@Injectable()
export class RedisActiveSetCache implements ActiveSetCache {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ShopFunctionsConfig,
  ) {}

  async getMany(shopIds: string[]) {
    const found = new Map<string, ActiveFunction[]>();
    if (shopIds.length === 0) return found;
    const raw = await this.redis.client.mget(shopIds.map(key));
    raw.forEach((value, i) => {
      if (value === null) return;
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every(isActive))
          found.set(shopIds[i], parsed);
      } catch {
        // corrupt entry: a miss
      }
    });
    return found;
  }

  async setMany(entries: Map<string, ActiveFunction[]>) {
    if (entries.size === 0) return;
    const pipeline = this.redis.client.pipeline();
    for (const [shopId, set] of entries)
      pipeline.set(
        key(shopId),
        JSON.stringify(set),
        'EX',
        this.config.cacheTtlSec,
      );
    await pipeline.exec();
  }

  async drop(shopId: string) {
    await this.redis.client.del(key(shopId));
  }
}
