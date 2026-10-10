import { Injectable } from '@nestjs/common';
import { PAYMENT_CURRENCIES } from '@marketplace-sandbox/contracts';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { orderEvents } from '../application/events/order-events';
import {
  OrderCopyService,
  type OrderFact,
} from '../application/order-copy.service';
import { PaymentCancellationService } from '../application/payment-cancellation.service';
import { consumerDeadLetteredCounter } from '../domain/payment-metrics';

const RELEVANT = new Set(['order.reserved', 'order.paid', 'order.cancelled']);

/**
 * Order facts from `orders.events` (S13 US6, FR-005, FR-035): keeps the order copy (R3) current and reacts to a
 * cancellation. Own consumer group. The idempotency mechanism is the version guard on the copy (`orderVersion`): a
 * duplicate, a stale or an out-of-order message changes nothing. A payload that is not valid for its contract, carries
 * a currency payments does not handle or comes in a contract version this consumer does not know is a permanent failure
 * for the dead-letter topic (the framework validates before `project`; the checks here make a direct call as safe);
 * every other `order.*` type is skipped.
 */
@Injectable()
export class OrdersEventsConsumer implements Projector {
  readonly name = 'payments-order-copy';
  readonly topics = [orderEvents().reserved.topic];
  readonly idempotency: IdempotencyMechanism = 'versionGuard';
  readonly handles: HandledEvent[] = [
    { event: orderEvents().reserved },
    { event: orderEvents().paid },
    { event: orderEvents().cancelled },
  ];

  constructor(
    private readonly copies: OrderCopyService,
    private readonly cancellation: PaymentCancellationService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      const fact = this.parse(event);
      if (!fact) continue;
      await this.copies.apply(fact);
      if (fact.type === 'order.cancelled')
        await this.cancellation.onOrderCancelled(fact.payload.orderId);
    }
  }

  /** The order fact of an envelope; null for an `order.*` type payments does not use. */
  private parse(raw: EventEnvelope): OrderFact | null {
    if (!RELEVANT.has(raw.type)) return null;
    const defs = orderEvents();
    let fact: OrderFact | null = null;
    try {
      const reserved = defs.reserved.match(raw);
      const paid = defs.paid.match(raw);
      const cancelled = defs.cancelled.match(raw);
      if (reserved)
        fact = { type: 'order.reserved', payload: reserved.payload };
      else if (paid) fact = { type: 'order.paid', payload: paid.payload };
      else if (cancelled)
        fact = { type: 'order.cancelled', payload: cancelled.payload };
    } catch {
      throw this.refuse(raw, 'invalid_payload');
    }
    if (!fact) throw this.refuse(raw, 'invalid_payload'); // a version this consumer does not understand
    if (
      fact.type !== 'order.cancelled' &&
      !(PAYMENT_CURRENCIES as readonly string[]).includes(fact.payload.currency)
    )
      throw this.refuse(raw, 'invalid_payload');
    return fact;
  }

  private refuse(raw: EventEnvelope, reason: string): PermanentError {
    consumerDeadLetteredCounter.add(1, { reason });
    return new PermanentError(`${reason}: ${raw.type}`);
  }
}
