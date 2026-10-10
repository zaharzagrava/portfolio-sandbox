import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import type {
  BasketRow,
  BasketStore,
  EdgeQuery,
  EdgeRow,
} from '../domain/recommendation-ports';

/** ClickHouse `DateTime64(3)` text for JSON inserts and query parameters: UTC, no zone suffix. */
const chTime = (date: Date): string =>
  date.toISOString().replace('T', ' ').replace('Z', '');

/**
 * The basket store over ClickHouse `recommendation_baskets` (ReplacingMergeTree on `order_version`). Readers use `FINAL`;
 * the capture service decides what to insert, this class only moves rows (S34 R-3, R-4, R-6).
 */
@Injectable()
export class ClickhouseBasketStoreAdapter implements BasketStore {
  private readonly sink: ClickHouseSink;

  constructor(private readonly clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async storedVersions(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.clickhouse.query<{ order_id: string; v: string }>(
      `SELECT order_id, max(order_version) AS v
       FROM recommendation_baskets
       WHERE order_id IN {ids:Array(String)}
       GROUP BY order_id`,
      { ids: orderIds },
    );
    return new Map(rows.map((r) => [r.order_id, Number(r.v)]));
  }

  async insert(rows: BasketRow[]): Promise<void> {
    await this.sink.insert(
      'recommendation_baskets',
      rows.map((r) => ({
        order_id: r.orderId,
        buyer_id: r.buyerId,
        products: r.products,
        paid_at: chTime(r.paidAt),
        order_version: r.orderVersion,
      })),
    );
  }

  async isEmpty(since: Date): Promise<boolean> {
    const [row] = await this.clickhouse.query<{ n: string }>(
      `SELECT count() AS n FROM
         (SELECT 1 FROM recommendation_baskets FINAL
          WHERE paid_at >= {since:DateTime64(3, 'UTC')} LIMIT 1)`,
      { since: chTime(since) },
    );
    return Number(row?.n ?? 0) === 0;
  }

  async edges(query: EdgeQuery): Promise<EdgeRow[]> {
    const rows = await this.clickhouse.query<{
      a: string;
      b: string;
      co: string;
      score: number;
    }>(
      `WITH
         baskets AS (
           SELECT products, buyer_id FROM recommendation_baskets FINAL
           WHERE paid_at >= {since:DateTime64(3, 'UTC')}
         ),
         item_orders AS (
           SELECT p, count() AS n FROM baskets ARRAY JOIN products AS p GROUP BY p
         ),
         pairs AS (
           SELECT a, b, count() AS co, uniqExact(buyer_id) AS buyers
           FROM baskets
           ARRAY JOIN products AS a
           ARRAY JOIN products AS b
           WHERE a != b AND cityHash64(a) % {buckets:UInt32} = {bucket:UInt32}
           GROUP BY a, b
           HAVING co >= {minCo:UInt32} AND buyers >= {minBuyers:UInt32}
         )
       SELECT pairs.a AS a, pairs.b AS b, pairs.co AS co,
              pairs.co / sqrt(ia.n * ib.n) AS score
       FROM pairs
       INNER JOIN item_orders AS ia ON ia.p = pairs.a
       INNER JOIN item_orders AS ib ON ib.p = pairs.b
       ORDER BY a, score DESC, b ASC
       LIMIT {k:UInt32} BY a`,
      {
        since: chTime(query.since),
        buckets: query.buckets,
        bucket: query.bucket,
        minCo: query.minCoOrders,
        minBuyers: query.minBuyers,
        k: query.top,
      },
    );
    return rows.map((r) => ({
      a: r.a,
      b: r.b,
      co: Number(r.co),
      score: Number(r.score),
    }));
  }
}
