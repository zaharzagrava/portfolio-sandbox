import { Injectable } from '@nestjs/common';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { OrderPaid, OrderRefunded } from '@app/domains/orders';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { assetMetrics } from '../application/asset-metrics';
import { EntitlementService } from '../application/entitlement.service';

export const ORDERS_CONSUMER = 'asset-library-orders';

/**
 * `order.paid` and `order.refunded` (`orders.events`, key = order ID; S31 FR-040, FR-041, D8). The payload shapes are
 * S10's own schemas from `packages/contracts`. The framework validates and dead-letters; this class validates again so
 * a direct delivery (a spec, a replay tool) can never apply a payload that does not parse. `natural` idempotency: the
 * entitlement is unique per `(order, product)`, a revocation is recorded per order, and every step is conditional.
 */
@Injectable()
export class AssetOrdersConsumer implements Projector {
  readonly name: string = ORDERS_CONSUMER;
  readonly topics: string[] = [OrderPaid.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    { event: OrderPaid },
    { event: OrderRefunded },
  ];

  constructor(private readonly entitlements: EntitlementService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      // this class understands contract version 1 only; a newer one is the framework's to dead-letter
      if (event.version !== 1) throw this.invalid(event.type);
      if (event.type === OrderPaid.type) {
        const parsed = orderEventSchemas['order.paid'].safeParse(event.payload);
        if (!parsed.success) throw this.invalid(event.type);
        await this.entitlements.onPaid(parsed.data);
      } else if (event.type === OrderRefunded.type) {
        const parsed = orderEventSchemas['order.refunded'].safeParse(
          event.payload,
        );
        if (!parsed.success) throw this.invalid(event.type);
        await this.entitlements.onRefunded(
          parsed.data,
          new Date(event.occurredAt),
        );
      }
      // any other type on the topic is not ours; the framework skips what `handles` does not list
    }
  }

  private invalid(type: string): PermanentError {
    assetMetrics.entitlements.add(1, { event: 'dead_lettered' });
    return new PermanentError(`invalid ${type} payload`);
  }
}
