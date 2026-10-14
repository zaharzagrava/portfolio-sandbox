import { Injectable } from '@nestjs/common';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { SettlementService } from '../application/settlement.service';

/**
 * The results of the orders this capability asked for (`orders.events`, key = order ID; S21 FR-029, research R-05):
 * `order.paid` sells the auction, `order.cancelled` (cancelled, lapsed, payment failed) sends the unit to the runner-up
 * once or back to the shelf. The payload shapes are S10's own schemas from `packages/contracts`, never copied. Every
 * step is a conditional transition under the auction's lock plus a per-order version guard (`natural` idempotency), so
 * a duplicate, late or out-of-order message moves nothing backwards. An invalid payload can never be applied
 * (`PermanentError`, dead letter); an order that is not ours is ignored; the order a request created whose ID is not
 * stored yet is held for redelivery (`TransientError`).
 */
@Injectable()
export class AuctionSettlementConsumer implements Projector {
  readonly name = 'auctions-order-results';
  readonly topics = [OrderPaid.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [
    { event: OrderPaid },
    { event: OrderCancelled },
  ];

  constructor(private readonly settlement: SettlementService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) await this.apply(event);
  }

  private async apply(event: EventEnvelope): Promise<void> {
    if (event.type === 'order.paid') {
      const parsed = orderEventSchemas['order.paid'].safeParse(event.payload);
      if (!parsed.success)
        throw new PermanentError('invalid order.paid payload');
      const p = parsed.data;
      const outcome = await this.settlement.onOrderPaid({
        orderId: p.orderId,
        orderVersion: p.orderVersion,
        userId: p.userId,
        totalMinor: p.totalMinor,
      });
      if (outcome === 'held')
        throw new TransientError('the order ID is not stored yet');
      return;
    }
    if (event.type === 'order.cancelled') {
      const parsed = orderEventSchemas['order.cancelled'].safeParse(
        event.payload,
      );
      if (!parsed.success)
        throw new PermanentError('invalid order.cancelled payload');
      const p = parsed.data;
      await this.settlement.onOrderCancelled({
        orderId: p.orderId,
        orderVersion: p.orderVersion,
        userId: p.userId,
      });
      return;
    }
    // any other type on the topic is not ours; the framework skips what `handles` does not list
  }
}
