import { Injectable } from '@nestjs/common';
import { paymentEventSchemas } from '@marketplace-sandbox/contracts';
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
import {
  PaymentFailed,
  PaymentRefunded,
  PaymentSucceeded,
} from '../application/events/payment-events';
import { PaymentResultService } from '../application/payment-result.service';

const ACTOR = 'system:consumer';

/**
 * Payment results from the payments capability (`payments.events`, S10 FR-040): the same guarded transitions as the
 * webhook, so the two paths converge and whichever arrives first wins. Duplicates are harmless because every transition
 * is conditional (`natural` idempotency); a message that cannot be applied (bad payload, amount or currency that does
 * not match the order) is a permanent failure for the dead-letter topic, a condition that may clear is transient.
 * The framework validates every message against the event definitions before `project`; the checks here repeat the
 * essential ones so a direct call is as safe.
 */
@Injectable()
export class PaymentsEventsConsumer implements Projector {
  readonly name = 'orders-payment-results';
  readonly topics = [PaymentSucceeded.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [
    { event: PaymentSucceeded },
    { event: PaymentFailed },
    { event: PaymentRefunded },
  ];

  constructor(private readonly results: PaymentResultService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) await this.apply(event);
  }

  private async apply(event: EventEnvelope): Promise<void> {
    const schema =
      paymentEventSchemas[event.type as keyof typeof paymentEventSchemas];
    if (!schema) throw new PermanentError(`unknown payment event type`);
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success)
      throw new PermanentError('invalid payment event payload');
    const p = parsed.data;

    const order = await this.results.find(p.orderId);
    if (!order) throw new PermanentError('order not found');

    switch (event.type) {
      case 'payments.payment_succeeded': {
        if (
          p.amountMinor !== order.totalMinor ||
          p.currency.toUpperCase() !== order.currency.toUpperCase()
        )
          throw new PermanentError('payment does not match the order');
        // `payment_failed` may carry no reference (S13); a success always does.
        if (!p.paymentRef)
          throw new PermanentError('payment_succeeded without a reference');
        const result = await this.results.applySuccess(
          order.id,
          p.paymentRef,
          ACTOR,
        );
        if (result === 'order_pending')
          throw new TransientError('order not reserved yet');
        return;
      }
      case 'payments.payment_failed':
        await this.results.applyFailure(order.id, ACTOR);
        return;
      case 'payments.payment_refunded': {
        const result = await this.results.applyRefund(
          order.id,
          p.amountMinor,
          `${ACTOR}:${event.eventId}`,
        );
        if (result === 'not_yet_paid')
          throw new TransientError('refund before payment');
        return;
      }
    }
  }
}
