import { Injectable } from '@nestjs/common';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { UsageRecorded } from '../application/usage.service';

/** `usage.events` → ClickHouse `usage_events` (batched async inserts; dedupe by event_id at merge/FINAL). */
@Injectable()
export class UsageProjector implements Projector {
  readonly name = 'usage-to-clickhouse';
  readonly topics = [UsageRecorded.topic];

  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const rows = events
      .map((e) => UsageRecorded.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => ({ event_id: e.eventId, subject_id: e.aggregateId, metric: e.payload.metric, quantity: e.payload.quantity, ts: e.payload.ts.replace('Z', '') }));
    await this.sink.insert('usage_events', rows);
  }
}
