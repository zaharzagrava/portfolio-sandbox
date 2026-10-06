import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { boughtTogetherKey, boughtTogetherStagingKey, NEIGHBOURS } from './recommendation-keys';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'recommendations.build-bought-together': { days?: number; buckets?: number };
  }
}

/** Pairs seen in fewer orders than this are noise, not a signal. */
const MIN_CO_ORDERS = 3;
const TTL_SECONDS = 3 * 86_400;

interface NeighbourRow {
  a: string;
  b: string;
  co: string;
  score: number;
}

/**
 * Nightly "frequently bought together" build.
 *
 * Score = cosine(a, b) = co(a,b) / sqrt(orders(a) * orders(b)). Raw
 * co-occurrence would put the iPhone next to everything (it's in every basket);
 * cosine divides that popularity back out, so "MagSafe charger ↔ iPhone 17
 * case" outranks "MagSafe charger ↔ iPhone 17".
 *
 * The pair explosion (arrayJoin of basket × basket) is processed in N
 * cityHash buckets of the anchor product, so each ClickHouse query and each
 * Redis write batch stays bounded however big the catalog gets. Each product's
 * list is written to a staging key then RENAMEd over the live one: readers
 * never see a half-written ZSET.
 */
@Injectable()
export class CoOccurrenceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(CoOccurrenceJobs.name);

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'recommendations.build-bought-together', cron: '17 3 * * *', jobType: 'recommendations.build-bought-together', payload: {} });
  }

  @JobHandler('recommendations.build-bought-together', { concurrency: 1, leaseMs: 3_600_000 })
  async build({ days = 180, buckets = 16 }: { days?: number; buckets?: number } = {}): Promise<{ products: number; edges: number }> {
    let products = 0;
    let edges = 0;
    for (let bucket = 0; bucket < buckets; bucket++) {
      const rows = await this.clickhouse.query<NeighbourRow & Record<string, unknown>>(
        `WITH
           baskets AS (
             SELECT products FROM order_baskets FINAL WHERE ts >= now() - INTERVAL {days:UInt32} DAY
           ),
           item_orders AS (
             SELECT p, count() AS n FROM baskets ARRAY JOIN products AS p GROUP BY p
           ),
           pairs AS (
             SELECT a, b, count() AS co
             FROM baskets
             ARRAY JOIN products AS a
             ARRAY JOIN products AS b
             WHERE a != b AND cityHash64(a) % {buckets:UInt32} = {bucket:UInt32}
             GROUP BY a, b
             HAVING co >= {minCo:UInt32}
           )
         SELECT pairs.a AS a, pairs.b AS b, pairs.co AS co,
                pairs.co / sqrt(ia.n * ib.n) AS score
         FROM pairs
         INNER JOIN item_orders AS ia ON ia.p = pairs.a
         INNER JOIN item_orders AS ib ON ib.p = pairs.b
         ORDER BY a, score DESC, b
         LIMIT {k:UInt32} BY a`,
        { days, buckets, bucket, minCo: MIN_CO_ORDERS, k: NEIGHBOURS },
      );

      const byProduct = new Map<string, NeighbourRow[]>();
      for (const row of rows) byProduct.set(row.a, [...(byProduct.get(row.a) ?? []), row]);

      const pipeline = this.redis.client.pipeline();
      for (const [productId, neighbours] of byProduct) {
        const staging = boughtTogetherStagingKey(productId);
        pipeline.del(staging);
        pipeline.zadd(staging, ...neighbours.flatMap((n) => [n.score, n.b]));
        pipeline.expire(staging, TTL_SECONDS);
        pipeline.rename(staging, boughtTogetherKey(productId));
      }
      await pipeline.exec();
      products += byProduct.size;
      edges += rows.length;
    }
    // Products that lost all edges keep their old list until the TTL - stale-but-plausible beats empty.
    this.logger.log(`bought-together: ${products} products, ${edges} edges`);
    return { products, edges };
  }
}
