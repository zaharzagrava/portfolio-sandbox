import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OrderPaid } from '@app/domains/orders';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { BasketCaptureService } from '../../application/basket-capture.service';

/**
 * Group `discovery-order-baskets` (S34 FR-013 to FR-015): every `order.paid` on `orders.events` becomes one basket for the
 * next build. `versionGuard`: a basket is replaced only by a strictly higher `orderVersion`, so redelivery and reordering
 * change nothing. Other order events are valid but not ours and are skipped by the framework without a dead letter.
 */
@Injectable()
export class OrderBasketsProjector implements Projector {
  readonly name = 'discovery-order-baskets';
  readonly topics = [OrderPaid.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: OrderPaid }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly capture: BasketCaptureService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.capture.capture(
      events.flatMap((e) =>
        e.type === OrderPaid.type && e.version === OrderPaid.version
          ? [{ aggregateId: e.aggregateId, payload: e.payload }]
          : [],
      ),
    );
  }
}
