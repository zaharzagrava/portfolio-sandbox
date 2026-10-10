import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  consumerDeadLetteredCounter,
  refundRequestsCounter,
} from '../domain/payment-metrics';
import { PAYMENT_REPOSITORY, type PaymentRepository } from '../domain/ports';
import { PaymentCancellationService } from './payment-cancellation.service';
import { PaymentRefundService } from './payment-refund.service';
import { PaymentTransitionService } from './payment-transition.service';

export const REFUND_QUEUE = 'orders-refund-requested';
export const REFUND_DLQ = 'orders-refund-requested-dlq';

/**
 * The transport shape of `orders.refund_requested` (contracts `refundRequestedSchema` with `reason` left open): a body
 * that fails it never reaches the service; a reason other than `order_cancelled` is refused by the service with its
 * own metric reason.
 */
export const refundMessageSchema = z.object({
  orderId: z.string().uuid(),
  paymentRef: z.string().min(1).max(255),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8),
  reason: z.string().min(1).max(64),
});
export type RefundMessage = z.infer<typeof refundMessageSchema>;

export type RefundRequestResult =
  | 'accepted'
  | 'duplicate'
  | 'nothing_to_refund'
  | 'cancelled'
  | 'waiting'
  | 'dead_lettered';

const ACTOR = 'system:refund';

/**
 * Handler of `orders.refund_requested` (S13 US6, FR-036): validates the request against the payment (full refunds only,
 * matching amount, currency and reference; anything else is dead-lettered with a reason and no effect), then acts by the
 * payment's state: completed → `REFUND_PENDING` plus the refund job; already refunding or refunded → acknowledged;
 * failed or cancelled → nothing to refund; not started → cancelled; running or unknown → wait (a job), acknowledged.
 */
@Injectable()
export class RefundRequestService {
  private readonly logger = new Logger(RefundRequestService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    private readonly transitions: PaymentTransitionService,
    private readonly refunds: PaymentRefundService,
    private readonly cancellation: PaymentCancellationService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly queue?: TaskQueue,
  ) {}

  async handle(body: unknown): Promise<RefundRequestResult> {
    const parsed = refundMessageSchema.safeParse(body);
    if (!parsed.success) return this.deadLetter(body, 'invalid_payload');
    const msg = parsed.data;

    const payment = await this.payments.findByOrderId(msg.orderId);
    if (!payment) return this.deadLetter(body, 'payment_not_found');
    if (msg.reason !== 'order_cancelled')
      return this.deadLetter(body, 'unsupported_reason');
    if (payment.providerRef && payment.providerRef !== msg.paymentRef)
      return this.deadLetter(body, 'refund_ref_mismatch');
    if (msg.amountMinor !== payment.amountMinor)
      return this.deadLetter(body, 'refund_amount_mismatch');
    if (msg.currency !== payment.currency)
      return this.deadLetter(body, 'refund_currency_mismatch');

    switch (payment.status) {
      case 'COMPLETED': {
        await this.transitions.apply(
          payment.id,
          { type: 'requestRefund' },
          ACTOR,
        );
        await this.refunds.schedule(
          payment.id,
          this.clock.now(),
          `refund:${payment.id}`,
        );
        refundRequestsCounter.add(1, { result: 'accepted' });
        return 'accepted';
      }
      case 'REFUND_PENDING':
      case 'REFUNDED':
        refundRequestsCounter.add(1, { result: 'duplicate' });
        return 'duplicate';
      case 'FAILED':
      case 'CANCELLED':
        refundRequestsCounter.add(1, { result: 'nothing_to_refund' });
        return 'nothing_to_refund';
      case 'PENDING':
      case 'UNKNOWN': {
        if (payment.status === 'PENDING' && !payment.chargeAttemptedAt) {
          await this.cancellation.onOrderCancelled(payment.orderId);
          refundRequestsCounter.add(1, { result: 'cancelled' });
          return 'cancelled';
        }
        if (payment.status === 'PENDING' && payment.requiresAction)
          await this.cancellation.onOrderCancelled(payment.orderId);
        await this.refunds.startWaiting(payment);
        refundRequestsCounter.add(1, { result: 'waiting' });
        return 'waiting';
      }
    }
  }

  /** Sends the message to the dead-letter queue with its reason and counts it; the original is acknowledged. */
  private async deadLetter(
    body: unknown,
    reason: string,
  ): Promise<RefundRequestResult> {
    consumerDeadLetteredCounter.add(1, { reason });
    this.logger.warn(`refund request dead-lettered: ${reason}`);
    await this.queue?.enqueue(REFUND_DLQ, { reason, body });
    return 'dead_lettered';
  }
}
