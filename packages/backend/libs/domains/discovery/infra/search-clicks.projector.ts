import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { SearchResultClicked } from '../application/events/search-click-events';

@Injectable()
export class SearchClicksProjector implements Projector {
  readonly name = 'search-clicks';
  readonly topics = [SearchResultClicked.topic];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.sink.insert(
      'search_clicks',
      events
        .map((e) => SearchResultClicked.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({
          event_id: e.eventId,
          query: e.payload.query,
          product_id: e.payload.productId,
          position: e.payload.position,
          ts: e.occurredAt.replace('Z', ''),
        })),
    );
  }
}
