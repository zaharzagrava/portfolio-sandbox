import { Inject, Injectable } from '@nestjs/common';
import type { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { AnalyticsStoreUnavailableError } from '../domain/errors';
import type {
  DayPoint,
  MinutePoint,
  RefundShare,
  SalesHistoryRepository,
  SalesWindow,
} from '../domain/ports';
import type { SaleRow } from '../domain/sale-facts';

/** The ClickHouse client of the sales history; a spec swaps it for one that fails or stalls on demand. */
export const INSIGHTS_CLICKHOUSE = Symbol('SELLER_INSIGHTS_CLICKHOUSE');
/** Analytics store calls give up after 3 seconds (S40 FR-036, FR-045). */
export const ANALYTICS_TIMEOUT_MS = 3_000;

type Store = Pick<ClickHouseService, 'insert' | 'query' | 'getClient'>;

const ts = (at: Date): string =>
  at.toISOString().replace('T', ' ').replace('Z', '');

/**
 * Every figure is computed from the deduplicated facts: rows are grouped by their natural key (order, product) and the
 * latest version of each is taken (`argMax` by `ingested_at`) before summing. That is exact without `FINAL` and before
 * the engine has merged anything (S40 R-6).
 */
const SALES = `
  SELECT order_id, product_id,
         argMax(paid_at, ingested_at) AS sold_at,
         argMax(buyer_id, ingested_at) AS buyer,
         argMax(title, ingested_at) AS product_title,
         argMax(units, ingested_at) AS sold_units,
         argMax(line_total_minor, ingested_at) AS revenue
  FROM shop_sale_facts
  WHERE shop_id = {shopId:String}
    AND paid_at >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
    AND paid_at < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
  GROUP BY order_id, product_id`;

const REFUNDS = `
  SELECT order_id,
         argMax(refunded_at, ingested_at) AS refunded_on,
         argMax(amount_minor, ingested_at) AS amount
  FROM shop_refund_facts
  WHERE shop_id = {shopId:String}
    AND refunded_at >= fromUnixTimestamp64Milli({fromMs:Int64}, 'UTC')
    AND refunded_at < fromUnixTimestamp64Milli({toMs:Int64}, 'UTC')
  GROUP BY order_id`;

@Injectable()
export class ClickHouseSalesHistory implements SalesHistoryRepository {
  constructor(@Inject(INSIGHTS_CLICKHOUSE) private readonly store: Store) {}

  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new AnalyticsStoreUnavailableError(error);
    }
  }

  private query<T extends Record<string, unknown>>(
    sql: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    return this.guarded(() =>
      this.store.query<T>(sql, params, { timeoutMs: ANALYTICS_TIMEOUT_MS }),
    );
  }

  async insertSales(rows: SaleRow[]): Promise<void> {
    await this.guarded(() =>
      this.store.insert(
        'shop_sale_facts',
        rows.map((r) => ({
          shop_id: r.shopId,
          order_id: r.orderId,
          product_id: r.productId,
          title: r.title,
          buyer_id: r.buyerId,
          units: r.units,
          line_total_minor: r.lineTotalMinor,
          paid_at: ts(r.paidAt),
        })),
        { timeoutMs: ANALYTICS_TIMEOUT_MS },
      ),
    );
  }

  async insertRefunds(
    rows: Array<{
      shopId: string;
      orderId: string;
      amountMinor: number;
      refundedAt: Date;
    }>,
  ): Promise<void> {
    await this.guarded(() =>
      this.store.insert(
        'shop_refund_facts',
        rows.map((r) => ({
          shop_id: r.shopId,
          order_id: r.orderId,
          amount_minor: r.amountMinor,
          refunded_at: ts(r.refundedAt),
        })),
        { timeoutMs: ANALYTICS_TIMEOUT_MS },
      ),
    );
  }

  async recordedShares(orderId: string): Promise<RefundShare[]> {
    const rows = await this.query<{ shop_id: string; amount: string }>(
      `SELECT shop_id, sum(revenue) AS amount FROM (
         SELECT shop_id, order_id, product_id, argMax(line_total_minor, ingested_at) AS revenue
         FROM shop_sale_facts WHERE order_id = {orderId:String}
         GROUP BY shop_id, order_id, product_id
       ) GROUP BY shop_id ORDER BY shop_id`,
      { orderId },
    );
    return rows.map((r) => ({
      shopId: r.shop_id,
      amountMinor: Number(r.amount),
    }));
  }

  async today(shopId: string, from: Date, to: Date) {
    const rows = await this.query<{
      minute: string;
      orders: string;
      units: string;
      revenue: string;
    }>(
      `SELECT toUnixTimestamp(toStartOfMinute(sold_at)) AS minute, uniqExact(order_id) AS orders,
              sum(sold_units) AS units, sum(revenue) AS revenue
       FROM (${SALES}) GROUP BY minute ORDER BY minute`,
      { shopId, fromMs: from.getTime(), toMs: to.getTime() },
    );
    const series: MinutePoint[] = rows.map((r) => ({
      minute: new Date(Number(r.minute) * 1000),
      orders: Number(r.orders),
      units: Number(r.units),
      revenueMinor: Number(r.revenue),
    }));
    return {
      orders: series.reduce((n, p) => n + p.orders, 0),
      units: series.reduce((n, p) => n + p.units, 0),
      revenueMinor: series.reduce((n, p) => n + p.revenueMinor, 0),
      series,
    };
  }

  async window(shopId: string, from: Date, to: Date): Promise<SalesWindow> {
    const params = { shopId, fromMs: from.getTime(), toMs: to.getTime() };
    const [daily, buyers, refunds, products] = await Promise.all([
      this.query<{
        day: string;
        orders: string;
        revenue: string;
        units: string;
      }>(
        `SELECT toString(toDate(sold_at, 'UTC')) AS day, uniqExact(order_id) AS orders,
                sum(revenue) AS revenue, sum(sold_units) AS units
         FROM (${SALES}) GROUP BY day ORDER BY day`,
        params,
      ),
      this.query<{ buyers: string }>(
        `SELECT uniqExact(buyer) AS buyers FROM (${SALES})`,
        params,
      ),
      this.query<{ day: string; refunds: string; amount: string }>(
        `SELECT toString(toDate(refunded_on, 'UTC')) AS day, count() AS refunds, sum(amount) AS amount
         FROM (${REFUNDS}) GROUP BY day ORDER BY day`,
        params,
      ),
      this.query<{
        product_id: string;
        title: string;
        revenue: string;
        units: string;
      }>(
        `SELECT product_id, argMax(product_title, sold_at) AS title, sum(revenue) AS revenue, sum(sold_units) AS units
         FROM (${SALES}) GROUP BY product_id ORDER BY revenue DESC, product_id ASC LIMIT 5`,
        params,
      ),
    ]);
    const refundedByDay = new Map(
      refunds.map((r) => [
        r.day,
        { count: Number(r.refunds), amount: Number(r.amount) },
      ]),
    );
    const days = new Set([...daily.map((d) => d.day), ...refundedByDay.keys()]);
    const sales = new Map(daily.map((d) => [d.day, d]));
    const points: DayPoint[] = [...days].sort().map((day) => ({
      day,
      revenueMinor: Number(sales.get(day)?.revenue ?? 0),
      orders: Number(sales.get(day)?.orders ?? 0),
      refundedMinor: refundedByDay.get(day)?.amount ?? 0,
    }));
    return {
      revenueMinor: daily.reduce((n, d) => n + Number(d.revenue), 0),
      orders: daily.reduce((n, d) => n + Number(d.orders), 0),
      unitsSold: daily.reduce((n, d) => n + Number(d.units), 0),
      uniqueBuyers: Number(buyers[0]?.buyers ?? 0),
      refundsCount: refunds.reduce((n, r) => n + Number(r.refunds), 0),
      refundedMinor: refunds.reduce((n, r) => n + Number(r.amount), 0),
      daily: points,
      topProducts: products.map((p) => ({
        productId: p.product_id,
        title: p.title,
        revenueMinor: Number(p.revenue),
        unitsSold: Number(p.units),
      })),
    };
  }

  async removeShop(shopId: string): Promise<void> {
    await this.guarded(async () => {
      for (const table of ['shop_sale_facts', 'shop_refund_facts'])
        await this.store.getClient().command({
          query: `ALTER TABLE ${table} DELETE WHERE shop_id = {shopId:String}`,
          query_params: { shopId },
          clickhouse_settings: { mutations_sync: '2' },
        });
    });
  }
}
