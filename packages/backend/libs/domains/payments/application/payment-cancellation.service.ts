import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRepository,
} from '../domain/ports';
import { classifyLookup } from '../domain/provider-outcome';
import { PaymentTransitionService } from './payment-transition.service';

import './payment.job-types';

const ACTOR = 'system:order-events';

export type OrderCancelledResult =
  'no_payment' | 'cancelled' | 'intent_cancel_scheduled' | 'left_alone';

/**
 * Saga compensation owned by the payment side (S13 FR-035): when the order is cancelled, a payment that has not started
 * charging is cancelled (the guard is the row itself, so a charge that starts at the same moment wins or loses cleanly);
 * a payment waiting for the customer has its provider intent cancelled by a durable job, so a hold that expired cannot
 * leave a live 3-D Secure intent the customer could still complete; a running or unknown payment is left to finish and is
 * refunded through the order system's refund command if it succeeds.
 */
@Injectable()
export class PaymentCancellationService {
  private readonly logger = new Logger(PaymentCancellationService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly transitions: PaymentTransitionService,
    private readonly jobs: JobsService,
  ) {}

  async onOrderCancelled(orderId: string): Promise<OrderCancelledResult> {
    const payment = await this.payments.findByOrderId(orderId);
    if (!payment) return 'no_payment';
    if (payment.status !== 'PENDING') return 'left_alone';

    if (payment.requiresAction) {
      await this.jobs.enqueue(
        'payments.cancel-intent',
        { paymentId: payment.id },
        { idempotencyKey: `cancel-intent:${payment.id}` },
      );
      return 'intent_cancel_scheduled';
    }
    if (payment.chargeAttemptedAt) return 'left_alone';

    const result = await this.transitions.apply(
      payment.id,
      { type: 'cancel', reason: 'order_cancelled' },
      ACTOR,
    );
    return result.kind === 'applied' || result.kind === 'already_applied'
      ? 'cancelled'
      : 'left_alone';
  }

  /**
   * Cancels the provider's intent of a payment waiting for the customer. Throws while the provider has not answered
   * (the job is retried with backoff) and returns once the payment reached a final status.
   */
  async cancelIntent(paymentId: string): Promise<void> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.status !== 'PENDING' || !payment.requiresAction)
      return;
    if (!payment.providerRef) {
      await this.transitions.apply(
        paymentId,
        { type: 'cancel', reason: 'order_cancelled' },
        ACTOR,
      );
      return;
    }

    const response = await this.provider.cancelIntent(
      payment.providerRef,
      `cancel:${paymentId}`,
    );
    if (response.kind === 'intent' && response.intent.status === 'canceled') {
      await this.transitions.apply(
        paymentId,
        { type: 'cancel', reason: 'order_cancelled' },
        ACTOR,
      );
      return;
    }
    if (
      response.kind === 'intent' ||
      (response.kind === 'http_error' && response.httpStatus < 500)
    ) {
      // The provider would not cancel it: ask what state it is in (it may have just succeeded).
      await this.settleFromProvider(payment);
      return;
    }
    throw new Error(
      `provider has not confirmed the cancellation of payment ${paymentId} (${response.kind})`,
    );
  }

  private async settleFromProvider(payment: PaymentRecord): Promise<void> {
    const response = await this.provider.retrieveIntent(payment.providerRef!);
    const outcome = classifyLookup(response, {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      orderId: payment.orderId,
    });
    switch (outcome.kind) {
      case 'succeeded':
        await this.transitions.apply(payment.id, { type: 'succeed' }, ACTOR, {
          providerRef: outcome.providerRef,
        });
        return;
      case 'failed':
        await this.transitions.apply(
          payment.id,
          { type: 'cancel', reason: 'order_cancelled' },
          ACTOR,
        );
        return;
      default:
        this.logger.warn(
          `payment ${payment.id}: intent could be neither cancelled nor settled yet (${outcome.kind})`,
        );
        throw new Error('provider intent state is not settled yet');
    }
  }
}
