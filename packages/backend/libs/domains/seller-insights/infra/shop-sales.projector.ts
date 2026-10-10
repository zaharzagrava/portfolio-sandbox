import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid } from '@app/domains/orders';

/** order.paid lines → ClickHouse `shop_sales` (+ minute rollup MV). ReplacingMergeTree absorbs replays. */
@Injectable()
export class ShopSalesProjector implements Projector {
  readonly name = 'shop-sales-olap';
  readonly topics = [OrderPaid.topic];
  // ReplacingMergeTree absorbs replays.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];
  private readonly sink: ClickHouseSink;

  constructor(
    clickhouse: ClickHouseService,
    @InjectModel(Product) private readonly products: typeof Product,
  ) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const paid = events
      .map((e) => OrderPaid.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    if (paid.length === 0) return;
    const ids = [
      ...new Set(paid.flatMap((e) => e.payload.lines.map((l) => l.productId))),
    ];
    const categories = new Map(
      (
        await this.products.findAll({
          where: { id: { [Op.in]: ids } },
          attributes: ['id', 'category'],
          raw: true,
        })
      ).map((p) => [p.id, p.category]),
    );
    await this.sink.insert(
      'shop_sales',
      paid.flatMap((e) =>
        e.payload.lines
          .filter((l) => l.shopId)
          .map((l) => ({
            order_id: e.aggregateId,
            shop_id: l.shopId,
            product_id: l.productId,
            category: categories.get(l.productId) ?? '',
            units: l.quantity,
            revenue: l.unitPriceMinor * l.quantity,
            ts: e.occurredAt.replace('Z', ''),
          })),
      ),
    );
  }
}
