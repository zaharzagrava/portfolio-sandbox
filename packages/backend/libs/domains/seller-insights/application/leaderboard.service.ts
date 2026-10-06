import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { ALL, boardKey, categoryBoard, revenueKey } from '../infra/leaderboard-keys';
import { parsePeriod, PeriodKind } from '../domain/periods';

export interface LeaderboardEntry {
  rank: number;
  shopId: string;
  name: string;
  revenue: number;
}

/**
 * Reads are O(log n + k) ZSET ops: top-k with ZREVRANGE, "my rank" with
 * ZREVRANK (exact; no ZCOUNT bucket approximation needed while a board fits
 * one ZSET - 10M members is fine). Shop names via the cache, one round trip.
 */
@Injectable()
export class LeaderboardService {
  constructor(
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  async top(kind: PeriodKind, periodId: string | undefined, category: string | undefined, limit = 20) {
    const period = parsePeriod(kind, periodId);
    const board = category ? categoryBoard(category) : ALL;
    const ids = await this.redis.client.zrevrange(boardKey(period.id, board), 0, limit - 1);
    if (ids.length === 0) return { period: period.id, board, entries: await this.fromSnapshot(period.id, board, limit) };

    const revenues = await this.redis.client.hmget(revenueKey(period.id, board), ...ids);
    const names = await this.shopNames(ids);
    const entries: LeaderboardEntry[] = ids.map((shopId, i) => ({ rank: i + 1, shopId, name: names.get(shopId) ?? 'Unknown shop', revenue: Number(revenues[i] ?? 0) }));
    return { period: period.id, board, entries };
  }

  async rank(shopId: string, kind: PeriodKind, periodId: string | undefined, category: string | undefined) {
    const period = parsePeriod(kind, periodId);
    const board = category ? categoryBoard(category) : ALL;
    const [rank, total, revenue] = await Promise.all([
      this.redis.client.zrevrank(boardKey(period.id, board), shopId),
      this.redis.client.zcard(boardKey(period.id, board)),
      this.redis.client.hget(revenueKey(period.id, board), shopId),
    ]);
    if (rank === null) throw new NotFoundException('No sales in this period');
    // "Top 3%" reads better than "#18,342 of 600,000" for the long tail.
    return { period: period.id, board, rank: rank + 1, of: total, topPercent: Math.max(1, Math.ceil(((rank + 1) / total) * 100)), revenue: Number(revenue ?? 0) };
  }

  /** Periods older than the Redis TTL are served from the frozen snapshot. */
  private async fromSnapshot(periodId: string, board: string, limit: number): Promise<LeaderboardEntry[]> {
    return this.sequelize.query<LeaderboardEntry>(
      `SELECT l.rank, l."shopId", coalesce(s.name, 'Unknown shop') AS name, l.revenue::bigint::float8 AS revenue
       FROM "LeaderboardSnapshot" l LEFT JOIN "Shop" s ON s.id = l."shopId"
       WHERE l.period = :periodId AND l.board = :board ORDER BY l.rank LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { periodId, board, limit } },
    );
  }

  private async shopNames(ids: string[]): Promise<Map<string, string>> {
    const rows = await Promise.all(
      ids.map((id) =>
        this.cache.getOrLoad<{ name: string }>(
          `shop:name:${id}`,
          async () => (await this.sequelize.query<{ name: string }>(`SELECT name FROM "Shop" WHERE id = :id`, { type: QueryTypes.SELECT, replacements: { id } }))[0] ?? null,
          { ttlMs: 3_600_000, negativeTtlMs: 60_000, l1: 'always', l1TtlMs: 60_000 },
        ),
      ),
    );
    return new Map(ids.map((id, i) => [id, rows[i]?.name ?? 'Unknown shop']));
  }
}
