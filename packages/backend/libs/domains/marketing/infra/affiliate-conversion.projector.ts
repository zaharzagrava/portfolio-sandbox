import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { ConversionIngestService } from '../application/conversion-ingest.service';
import {
  consumedOrderPaid,
  consumedOrderRefunded,
} from '../application/events/consumed-order-events';

/**
 * `orders.events` -> `AffiliateConversion` (J05): a paid order that carries an attribution becomes one conversion of the
 * link, a refund raises or reverses it. The framework validates each payload against the contract and dead-letters a
 * poison message to `marketing-affiliate-conversions.dlq`; duplicates are harmless (unique order row, version guard).
 */
@Injectable()
export class AffiliateConversionProjector implements Projector {
  readonly name = 'marketing-affiliate-conversions';
  readonly topics = [consumedOrderPaid.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: consumedOrderPaid },
    { event: consumedOrderRefunded },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly ingest: ConversionIngestService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const relevant: Parameters<ConversionIngestService['ingest']>[0] = [];
    for (const envelope of events) {
      const paid = consumedOrderPaid.match(envelope);
      if (paid) {
        relevant.push({ kind: 'paid', envelope, payload: paid.payload });
        continue;
      }
      const refunded = consumedOrderRefunded.match(envelope);
      if (refunded)
        relevant.push({
          kind: 'refunded',
          envelope,
          payload: refunded.payload,
        });
    }
    return this.ingest.ingest(relevant);
  }
}
