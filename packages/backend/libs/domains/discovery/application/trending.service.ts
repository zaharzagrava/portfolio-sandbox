import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { WINDOW_MS, windowKey } from '../infra/trending.consumer';

/**
 * "Trending in the last hour": ZUNION of the last 60 one-minute window ZSETs
 * (same hash tag → one slot), top 20, hydrated. Cached 30 s - the list is the
 * same for everyone and changes per minute anyway.
 */
@Injectable()
export class TrendingService {
  constructor(
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  async trending(category = 'all', minutes = 60, limit = 20) {
    return (
      (await this.cache.getOrLoad(
        `trending:view:${category}:${minutes}`,
        async () => {
          const now = Date.now();
          const last = now - (now % WINDOW_MS);
          const keys = Array.from({ length: minutes }, (_, i) =>
            windowKey(category, last - i * WINDOW_MS),
          );
          const flat = (await this.redis.client.call(
            'ZUNION',
            String(keys.length),
            ...keys,
            'AGGREGATE',
            'SUM',
            'WITHSCORES',
          )) as string[];
          const ranked: { id: string; score: number }[] = [];
          for (let i = 0; i < flat.length; i += 2)
            ranked.push({ id: flat[i], score: Number(flat[i + 1]) });
          ranked.sort((a, b) => b.score - a.score);
          const top = ranked.slice(0, limit);
          if (top.length === 0) return [];
          const products = new Map(
            (
              await this.sequelize.query<{
                id: string;
                title: string;
                price: string;
                category: string;
              }>(
                `SELECT id, title, price, category FROM "Product" WHERE id IN (:ids) AND quantity > 0`,
                {
                  type: QueryTypes.SELECT,
                  replacements: { ids: top.map((t) => t.id) },
                },
              )
            ).map((p) => [p.id, p]),
          );
          return top
            .filter((t) => products.has(t.id))
            .map((t) => ({
              ...products.get(t.id)!,
              price: Number(products.get(t.id)!.price),
              score: t.score,
            }));
        },
        { ttlMs: 30_000, l1: 'always', l1TtlMs: 10_000 },
      )) ?? []
    );
  }
}
