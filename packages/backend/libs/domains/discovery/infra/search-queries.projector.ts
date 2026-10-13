import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { SearchPerformed } from '../application/events/search-query-events';

@Injectable()
export class SearchQueriesProjector implements Projector {
  readonly name = 'search-queries';
  readonly topics = [SearchPerformed.topic];
  // ClickHouse keeps one row per event_id at merge time.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: SearchPerformed }];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.sink.insert(
      'search_queries',
      events
        .map((e) => SearchPerformed.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({
          event_id: e.eventId,
          search_id: e.payload.searchId ?? '',
          query: e.payload.query,
          results: e.payload.results,
          // events written before S32 carry none of these; the reader treats '' as typing (S33)
          mode: e.payload.mode ?? '',
          degraded: e.payload.degraded ?? [],
          surface: e.payload.surface ?? '',
          filters: e.payload.filters ?? [],
          user_hash: e.payload.userHash,
          ts: e.occurredAt.replace('Z', ''),
        })),
    );
  }
}
