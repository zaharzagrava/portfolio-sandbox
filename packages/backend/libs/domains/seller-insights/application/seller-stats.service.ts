import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { SellerStatsResponseDto } from '../api/seller-stats.dto';

const SCHEMA_FILE = 'clickhouse/001_seller_sales.sql';

/**
 * Seller dashboards read from ClickHouse, never Postgres: they aggregate
 * over every sale a seller ever made, which is exactly the scan-heavy OLAP
 * shape that would compete with the payment write path for OLTP resources.
 * // See README.md#adr -> "Why use ClickHouse for analytics?"
 */
@Injectable()
export class SellerStatsService implements OnModuleInit {
  private readonly l = new Logger(SellerStatsService.name);

  constructor(private readonly clickHouseService: ClickHouseService) { }

  async onModuleInit() {
    try {
      const ddl = fs.readFileSync(path.resolve(process.cwd(), SCHEMA_FILE), 'utf8');
      await this.clickHouseService.getClient().command({ query: ddl });
    } catch (error: any) {
      this.l.warn(`seller_sales schema not applied: ${error?.message ?? error}`);
    }
  }

  public async getStats(sellerId: string, days: number): Promise<SellerStatsResponseDto> {
    const params = { sellerId, days };
    const where = `seller_id = {sellerId:UUID} AND ts >= now64(3) - toIntervalDay({days:UInt32})`;

    // 64-bit ints come back as JSON strings from ClickHouse, hence Number().
    const [summaryRows, dailyRows, topRows] = await Promise.all([
      this.clickHouseService.query<{
        revenue: string;
        orders: string;
        units: string;
        unique_buyers: string;
        refunds: string;
      }>(
        `SELECT
           sumIf(amount_cents, status = 'COMPLETED')      AS revenue,
           countIf(status = 'COMPLETED')                  AS orders,
           sumIf(quantity, status = 'COMPLETED')          AS units,
           uniqCombinedIf(buyer_id, status = 'COMPLETED') AS unique_buyers,
           countIf(status = 'REFUNDED')                   AS refunds
         FROM seller_sales
         WHERE ${where}`,
        params,
      ),
      this.clickHouseService.query<{ day: string; revenue: string; orders: string }>(
        `SELECT
           toString(toDate(ts))                      AS day,
           sumIf(amount_cents, status = 'COMPLETED') AS revenue,
           countIf(status = 'COMPLETED')             AS orders
         FROM seller_sales
         WHERE ${where}
         GROUP BY day
         ORDER BY day`,
        params,
      ),
      this.clickHouseService.query<{ product_id: string; revenue: string; units: string }>(
        `SELECT
           toString(product_id) AS product_id,
           sum(amount_cents)    AS revenue,
           sum(quantity)        AS units
         FROM seller_sales
         WHERE ${where} AND status = 'COMPLETED'
         GROUP BY product_id
         ORDER BY revenue DESC
         LIMIT 5`,
        params,
      ),
    ]);

    const summary = summaryRows[0];
    const revenueCents = Number(summary?.revenue ?? 0);
    const orders = Number(summary?.orders ?? 0);

    return {
      sellerId,
      days,
      summary: {
        revenueCents,
        orders,
        unitsSold: Number(summary?.units ?? 0),
        uniqueBuyers: Number(summary?.unique_buyers ?? 0),
        refunds: Number(summary?.refunds ?? 0),
        avgOrderValueCents: orders > 0 ? Math.round(revenueCents / orders) : 0,
      },
      daily: dailyRows.map((row) => ({
        day: row.day,
        revenueCents: Number(row.revenue),
        orders: Number(row.orders),
      })),
      topProducts: topRows.map((row) => ({
        productId: row.product_id,
        revenueCents: Number(row.revenue),
        unitsSold: Number(row.units),
      })),
    };
  }
}
