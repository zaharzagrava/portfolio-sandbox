import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';

/** Today's minute series + totals for one shop, from the ClickHouse minute rollup (FINAL-free: SummingMergeTree + sum()). */
@Injectable()
export class ShopDashboardService {
  constructor(private readonly clickhouse: ClickHouseService) {}

  async today(shopId: string) {
    const series = await this.clickhouse.query<{ minute: string; orders: string; units: string; revenue: string }>(
      `SELECT toString(minute) AS minute, sum(orders) AS orders, sum(units) AS units, sum(revenue) AS revenue
       FROM shop_sales_minute WHERE shop_id = {shopId:String} AND minute >= toStartOfDay(now('UTC'))
       GROUP BY minute ORDER BY minute`,
      { shopId },
    );
    const points = series.map((r) => ({ minute: r.minute, orders: Number(r.orders), units: Number(r.units), revenue: Number(r.revenue) }));
    return {
      totals: points.reduce((t, p) => ({ orders: t.orders + p.orders, units: t.units + p.units, revenue: t.revenue + p.revenue }), { orders: 0, units: 0, revenue: 0 }),
      series: points,
    };
  }
}
