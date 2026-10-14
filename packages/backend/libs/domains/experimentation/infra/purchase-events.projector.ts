import { Inject, Injectable } from '@nestjs/common';
import { formatStoredTime } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { DeadLetterWriter } from '@app/infrastructure/projections/dead-letter';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderPaid } from '@app/domains/orders';
import { analyticsDeadLetterTotal } from '../application/analytics-metrics';

/**
 * Business events come from the server, not the browser (10/02 Ex2): an ad blocker can drop a client "purchase" pixel; the
 * outbox can't lose a paid order. One `order.paid` becomes one `purchase` row of the same store as client events, with the
 * envelope's event id as identity: a redelivery adds a copy that every read collapses (S39 FR-013, AS-15).
 *
 * The consumer framework already routes and validates each payload against `OrderPaid` and dead-letters a bad one before
 * `project` runs; the check here is the second line (a payload that reaches the handler unvalidated is dead-lettered and
 * counted, never stored). The contract names the amount `totalMinor`: it is stored as the prop `total`.
 */
@Injectable()
export class PurchaseEventsProjector implements Projector {
  readonly name = 'analytics-purchases';
  readonly topics = [OrderPaid.topic];
  // Identity is the envelope's event id; every read collapses copies of it.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: OrderPaid }];
  private readonly sink: ClickHouseSink;

  constructor(
    clickhouse: ClickHouseService,
    private readonly deadLetters: DeadLetterWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const receivedAt = formatStoredTime(this.clock.nowMs());
    const rows: Record<string, unknown>[] = [];
    for (const envelope of events) {
      if (envelope.type !== OrderPaid.type) continue;
      const parsed = OrderPaid.schema.safeParse(envelope.payload);
      if (!parsed.success) {
        await this.deadLetter(envelope, parsed.error.issues);
        continue;
      }
      rows.push({
        event_id: envelope.eventId,
        name: 'purchase',
        anonymous_id: '',
        user_id: parsed.data.userId,
        ts: formatStoredTime(Date.parse(envelope.occurredAt)),
        received_at: receivedAt,
        country: '',
        platform: 'server',
        page: '',
        props: {
          order_id: envelope.aggregateId,
          total: String(parsed.data.totalMinor),
          currency: parsed.data.currency || 'usd',
        },
      });
    }
    await this.sink.insert('analytics_event_log', rows);
  }

  /** Reason code and schema paths only: a payload value never reaches the dead-letter headers or a log. */
  private async deadLetter(
    envelope: EventEnvelope,
    issues: { path: PropertyKey[] }[],
  ): Promise<void> {
    const paths = [
      ...new Set(issues.map((i) => i.path.map(String).join('.') || '(root)')),
    ].join(', ');
    await this.deadLetters.write({
      consumer: this.name,
      topic: OrderPaid.topic,
      // The handler is not given the message coordinates: -1 says "unknown" (the envelope itself is kept).
      partition: -1,
      offset: '-1',
      key: Buffer.from(envelope.aggregateId),
      value: Buffer.from(JSON.stringify(envelope)),
      code: 'INVALID_PAYLOAD',
      reason: `payload of ${envelope.type} v${envelope.version} fails its schema at: ${paths}`,
      attempts: 0,
    });
    analyticsDeadLetterTotal.add(1, { source: 'purchase-projector' });
  }
}
