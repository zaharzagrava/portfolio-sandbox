import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid } from '@app/domains/orders';

/**
 * Business events come from the server, not the browser (10/02 Ex2): an ad
 * blocker can drop a client "purchase" pixel; the outbox can't lose a paid
 * order. Same table as client events, deduped by the envelope's event id.
 */
@Injectable()
export class PurchaseEventsProjector implements Projector {
  readonly name = 'analytics-purchases';
  readonly topics = [OrderPaid.topic];
  // Deduped by the envelope's event id at merge time.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const time = (iso: string) => iso.replace('T', ' ').replace('Z', '');
    await this.sink.insert(
      'analytics_events',
      events
        .map((e) => OrderPaid.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({
          event_id: e.eventId,
          name: 'purchase',
          anonymous_id: '',
          user_id: e.payload.userId,
          ts: time(e.occurredAt),
          received_at: time(new Date().toISOString()),
          country: '',
          platform: 'server',
          page: '',
          props: {
            order_id: e.aggregateId,
            total: String(e.payload.total),
            currency: e.payload.currency ?? 'usd',
          },
        })),
    );
  }
}
