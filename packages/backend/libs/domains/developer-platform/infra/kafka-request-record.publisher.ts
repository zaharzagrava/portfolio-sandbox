import { Injectable } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ApiRequestLogged } from '../application/events/api-events';
import { RequestRecord, RequestRecordPublisher } from '../domain/ports';
import { recordEventId } from '../domain/request-record';

/** The `api.request_logged` envelope of a record: its event id is derived from the request id, so a redelivery is recognised. */
export function requestLoggedEnvelope(r: RequestRecord) {
  return {
    ...ApiRequestLogged.create(
      r.shopId,
      0,
      {
        requestId: r.requestId,
        ...(r.clientRequestId ? { clientRequestId: r.clientRequestId } : {}),
        shopId: r.shopId,
        keyId: r.keyId,
        livemode: r.livemode,
        version: r.version,
        method: r.method,
        route: r.route,
        status: r.status,
        durationMs: r.durationMs,
        deprecated: r.deprecated,
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        ...(r.batchOps !== undefined ? { batchOps: r.batchOps } : {}),
        idempotentReplay: r.idempotentReplay,
        cost: r.cost,
      },
      r.occurredAt,
    ),
    eventId: recordEventId(r.requestId),
  };
}

/** The event bus at its edge: one produce request per batch, keyed by the live shop. */
@Injectable()
export class KafkaRequestRecordPublisher extends RequestRecordPublisher {
  constructor(private readonly producer: KafkaProducerService) {
    super();
  }

  async publish(records: RequestRecord[]): Promise<void> {
    await this.producer.sendMany(
      ApiRequestLogged.topic,
      records.map((r) => ({ key: r.shopId, value: requestLoggedEnvelope(r) })),
    );
  }
}
