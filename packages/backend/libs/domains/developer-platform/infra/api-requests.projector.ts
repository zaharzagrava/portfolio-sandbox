import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ApiRequestLogged } from '../application/events/api-events';
import { RequestLogStore } from '../domain/ports';

/**
 * `api.request_logged` → the shop's request log (FR-056, AS-62, group `public-api-request-log`). A record is stored once
 * per `(shop, request id)`: a redelivery, and the same request under another event id, add nothing. A payload that is not
 * valid is dead-lettered and writes no row; a record of an unknown shop is stored, the log is owned here.
 */
@Injectable()
export class ApiRequestsProjector implements Projector {
  readonly name = 'public-api-request-log';
  readonly topics = [ApiRequestLogged.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles = [{ event: ApiRequestLogged }];
  readonly attempts = 3;

  constructor(private readonly store: RequestLogStore) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const rows: Parameters<RequestLogStore['insertNew']>[0] = [];
    for (const envelope of events) {
      let matched;
      try {
        matched = ApiRequestLogged.match(envelope);
      } catch {
        throw new PermanentError('invalid api.request_logged payload');
      }
      if (!matched) continue;
      const p = matched.payload;
      rows.push({
        requestId: p.requestId,
        clientRequestId: p.clientRequestId ?? '',
        shopId: p.shopId,
        keyId: p.keyId,
        livemode: p.livemode,
        version: p.version,
        method: p.method,
        route: p.route,
        status: p.status,
        durationMs: p.durationMs,
        deprecated: p.deprecated,
        errorCode: p.errorCode ?? '',
        batchOps: p.batchOps ?? 0,
        idempotentReplay: p.idempotentReplay,
        at: new Date(matched.occurredAt),
      });
    }
    await this.store.insertNew(rows);
  }
}
