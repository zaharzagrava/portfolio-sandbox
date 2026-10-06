import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { ApiRequestLogged } from '../application/events/api-events';

@Injectable()
export class ApiRequestsProjector implements Projector {
  readonly name = 'api-requests-log';
  readonly topics = [ApiRequestLogged.topic];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.sink.insert(
      'api_requests',
      events
        .map((e) => ApiRequestLogged.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map(({ payload: p, occurredAt }) => ({
          request_id: p.requestId,
          shop_id: p.shopId,
          key_id: p.keyId,
          livemode: p.livemode ? 1 : 0,
          version: p.version,
          method: p.method,
          route: p.route,
          status: p.status,
          duration_ms: p.durationMs,
          deprecated: p.deprecated ? 1 : 0,
          ts: occurredAt.replace('Z', ''),
        })),
    );
  }
}
