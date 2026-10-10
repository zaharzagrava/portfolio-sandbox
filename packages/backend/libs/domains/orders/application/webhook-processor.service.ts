import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService, type InboxStatus } from '@app/infrastructure/inbox';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { PAYMENT_STATUS, type PaymentStatusPort } from '../domain/ports';
import { PaymentStatusUnavailableError } from '../domain/order-errors';
import { webhookEventCounter } from '../domain/order-metrics';
import { PaymentResultService } from './payment-result.service';
import type { ProcessWebhookPayload } from './order.job-types';

const SOURCE = 'stripe';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = 'system:webhook';

/** A condition that may clear with time (payments not reachable, order not reserved yet): the job retries. */
class RetryableWebhookError extends Error {
  constructor(readonly reason: string) {
    super(`webhook processing will be retried: ${reason}`);
    this.name = 'RetryableWebhookError';
  }
}

/**
 * Applies a stored provider event after it was acknowledged (S10 FR-035 to FR-039). The order comes from the intent
 * metadata only; a success is confirmed through the payments capability's status service (status, amount, currency)
 * before the order is marked paid. Every event ends in exactly one inbox status; a transient failure is thrown so the
 * job retries (S49 backoff with jitter), and the last attempt marks the event `FAILED` before the job dead-letters.
 */
@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly results: PaymentResultService,
    @Inject(PAYMENT_STATUS) private readonly payments: PaymentStatusPort,
  ) {}

  async process(
    event: ProcessWebhookPayload,
    ctx: Pick<JobContext, 'attempt' | 'maxAttempts' | 'isLastAttempt'>,
  ): Promise<void> {
    try {
      const [status, detail] = await this.apply(event, ctx);
      await this.finish(event, status, detail);
    } catch (error) {
      if (ctx.isLastAttempt) {
        await this.finish(
          event,
          'FAILED',
          error instanceof RetryableWebhookError
            ? error.reason
            : (error as Error).name,
        );
      }
      throw error;
    }
  }

  private async finish(
    event: ProcessWebhookPayload,
    status: InboxStatus,
    detail: string,
  ): Promise<void> {
    await this.inbox.markStatus(SOURCE, event.eventId, status, detail);
    webhookEventCounter.add(1, { result: status.toLowerCase() });
    if (status === 'REJECTED' || status === 'FAILED')
      this.logger.warn(
        `stripe event ${event.eventId} (${event.type}) ${status}: ${detail}`,
      );
  }

  private async apply(
    event: ProcessWebhookPayload,
    ctx: Pick<JobContext, 'isLastAttempt'>,
  ): Promise<[InboxStatus, string]> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        return this.succeeded(event, ctx);
      case 'payment_intent.payment_failed':
        return this.failed(event);
      case 'charge.refunded':
        return this.refunded(event);
      default:
        return ['IGNORED', 'unhandled_type'];
    }
  }

  private async succeeded(
    event: ProcessWebhookPayload,
    ctx: Pick<JobContext, 'isLastAttempt'>,
  ): Promise<[InboxStatus, string]> {
    const order = await this.orderOf(event);
    if (!order.found) return ['UNMATCHED', order.reason];
    if (!event.paymentRef) return ['UNMATCHED', 'no_payment_reference'];

    let payment;
    try {
      payment = await this.payments.getPaymentStatus(event.paymentRef);
    } catch (error) {
      if (error instanceof PaymentStatusUnavailableError)
        throw new RetryableWebhookError('payment_status_unavailable');
      throw error;
    }
    if (payment.status === 'PENDING' && !ctx.isLastAttempt)
      throw new RetryableWebhookError('payment_pending');
    if (payment.status !== 'COMPLETED')
      return ['REJECTED', 'payment_not_completed'];
    const record = order.record;
    if (
      (event.amountMinor !== null && event.amountMinor !== record.totalMinor) ||
      payment.amountMinor !== record.totalMinor
    )
      return ['REJECTED', 'amount_mismatch'];
    if (
      (event.currency !== null &&
        event.currency.toUpperCase() !== record.currency.toUpperCase()) ||
      payment.currency.toUpperCase() !== record.currency.toUpperCase()
    )
      return ['REJECTED', 'currency_mismatch'];

    const result = await this.results.applySuccess(
      record.id,
      event.paymentRef,
      ACTOR,
    );
    switch (result) {
      case 'paid':
        return ['PROCESSED', 'paid'];
      case 'already_paid':
        return ['PROCESSED', 'already_paid'];
      case 'refund_requested':
        return ['PROCESSED', 'paid_after_cancel'];
      case 'order_pending':
        throw new RetryableWebhookError('order_not_reserved_yet');
      case 'not_found':
        return ['UNMATCHED', 'order_not_found'];
    }
  }

  private async failed(
    event: ProcessWebhookPayload,
  ): Promise<[InboxStatus, string]> {
    const order = await this.orderOf(event);
    if (!order.found) return ['UNMATCHED', order.reason];
    const result = await this.results.applyFailure(order.record.id, ACTOR);
    switch (result) {
      case 'cancelled':
        return ['PROCESSED', 'cancelled'];
      case 'already_cancelled':
        return ['IGNORED', 'order_already_cancelled'];
      case 'already_paid':
        return ['IGNORED', 'order_already_paid'];
      case 'pending':
        return ['IGNORED', 'order_pending'];
      case 'not_found':
        return ['UNMATCHED', 'order_not_found'];
    }
  }

  private async refunded(
    event: ProcessWebhookPayload,
  ): Promise<[InboxStatus, string]> {
    const order = await this.orderOf(event);
    if (!order.found) return ['UNMATCHED', order.reason];
    const refunded = event.refundedMinor ?? event.amountMinor ?? 0;
    const result = await this.results.applyRefund(
      order.record.id,
      refunded,
      `${ACTOR}:${event.eventId}`,
    );
    switch (result) {
      case 'refunded':
        return ['PROCESSED', 'refunded'];
      case 'already_refunded':
        return ['PROCESSED', 'already_refunded'];
      case 'partial_recorded':
        return ['PROCESSED', 'partial_refund'];
      case 'not_yet_paid':
        throw new RetryableWebhookError('refund_before_payment');
      case 'not_refundable':
        return ['IGNORED', 'order_not_refundable'];
      case 'not_found':
        return ['UNMATCHED', 'order_not_found'];
    }
  }

  private async orderOf(event: ProcessWebhookPayload) {
    if (!event.orderId || !UUID.test(event.orderId))
      return { found: false as const, reason: 'no_order_id' };
    const record = await this.results.find(event.orderId);
    return record
      ? { found: true as const, record }
      : { found: false as const, reason: 'order_not_found' };
  }
}
