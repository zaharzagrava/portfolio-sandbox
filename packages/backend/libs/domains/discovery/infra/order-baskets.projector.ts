import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid } from '@app/domains/orders';

/** Baskets larger than this are B2B/bulk orders - they'd add O(n²) noise pairs. */
export const MAX_BASKET = 30;

@Injectable()
export class OrderBasketsProjector implements Projector {
  readonly name = 'order-baskets';
  readonly topics = [OrderPaid.topic];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const rows = events
      .map((e) => OrderPaid.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => ({
        order_id: e.aggregateId,
        products: [...new Set(e.payload.lines.map((l) => l.productId))].sort(),
        ts: e.occurredAt.replace('Z', ''),
      }))
      .filter((r) => r.products.length >= 2 && r.products.length <= MAX_BASKET);
    await this.sink.insert('order_baskets', rows);
  }
}
