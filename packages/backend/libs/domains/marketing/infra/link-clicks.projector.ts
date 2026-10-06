import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { LinkClicked } from '../application/share-link.service';

/** `links.events` → ClickHouse `link_clicks` (deduped by click id at merge time). */
@Injectable()
export class LinkClicksProjector implements Projector {
  readonly name = 'link-clicks';
  readonly topics = [LinkClicked.topic];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.sink.insert(
      'link_clicks',
      events
        .map((e) => LinkClicked.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({ click_id: e.payload.clickId, code: e.payload.code, ts: e.payload.ts.replace('Z', ''), country: e.payload.country, referer: e.payload.referer, via_edge: e.payload.viaEdge ? 1 : 0 })),
    );
  }
}
