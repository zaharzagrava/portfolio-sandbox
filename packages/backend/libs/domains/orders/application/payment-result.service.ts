import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  ORDER_HISTORY_REPOSITORY,
  ORDER_REPOSITORY,
  REFUND_COMMAND,
  type OrderHistoryRepository,
  type OrderRecord,
  type OrderRepository,
  type RefundCommandPort,
} from '../domain/ports';
import { paidAfterCancelCounter } from '../domain/order-metrics';
import { OrderLifecycleService } from './order-lifecycle.service';

export type SuccessResult =
  | 'paid'
  | 'already_paid'
  /** The order was cancelled meanwhile: a refund command was requested (once per payment). */
  | 'refund_requested'
  /** The order is not reserved yet: the caller retries. */
  | 'order_pending'
  | 'not_found';

export type FailureResult =
  'cancelled' | 'already_cancelled' | 'already_paid' | 'pending' | 'not_found';

export type RefundResult =
  | 'refunded'
  | 'already_refunded'
  | 'partial_recorded'
  /** The order was never paid (yet): the caller retries. */
  | 'not_yet_paid'
  | 'not_refundable'
  | 'not_found';

/**
 * What a provider's payment results do to an order (S10 FR-038 to FR-040). The webhook processor and the
 * `payments.events` consumer both call it, so both converge on the same guarded transitions: whichever arrives first
 * wins, the other finds the order already moved and reports it.
 */
@Injectable()
export class PaymentResultService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ORDER_HISTORY_REPOSITORY)
    private readonly history: OrderHistoryRepository,
    @Inject(REFUND_COMMAND) private readonly refunds: RefundCommandPort,
    private readonly lifecycle: OrderLifecycleService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  find(orderId: string): Promise<OrderRecord | null> {
    return this.orders.findById(orderId);
  }

  async applySuccess(
    orderId: string,
    paymentRef: string,
    actor: string,
  ): Promise<SuccessResult> {
    const result = await this.lifecycle.transition(
      orderId,
      { type: 'markPaid', paymentRef },
      { actor },
    );
    switch (result.kind) {
      case 'applied':
        return 'paid';
      case 'already_applied':
        return 'already_paid';
      case 'not_found':
        return 'not_found';
      case 'invalid':
        if (result.order.status === 'CANCELLED') {
          // A genuine payment for an order that is gone: the buyer's money must go back, exactly once per payment.
          await this.runner.run(() =>
            this.refunds.requestRefund({
              orderId,
              paymentRef,
              amountMinor: result.order.totalMinor,
              currency: result.order.currency,
            }),
          );
          paidAfterCancelCounter.add();
          return 'refund_requested';
        }
        return 'order_pending';
    }
  }

  async applyFailure(orderId: string, actor: string): Promise<FailureResult> {
    const result = await this.lifecycle.transition(
      orderId,
      { type: 'cancel', reason: 'payment_failed' },
      { actor },
    );
    switch (result.kind) {
      case 'applied':
        return 'cancelled';
      case 'already_applied':
        return 'already_cancelled';
      case 'not_found':
        return 'not_found';
      case 'invalid':
        return result.order.status === 'PENDING' ? 'pending' : 'already_paid';
    }
  }

  /**
   * A full refund moves the order to `REFUNDED`; a partial one only leaves a `partial_refund` history row. `actor`
   * names the source of the refund (for a provider event it carries the event id), so a redelivered job adds no second row.
   */
  async applyRefund(
    orderId: string,
    refundedMinor: number,
    actor: string,
  ): Promise<RefundResult> {
    const order = await this.orders.findById(orderId);
    if (!order) return 'not_found';
    if (refundedMinor < order.totalMinor) {
      if (order.status === 'RESERVED' || order.status === 'PENDING')
        return 'not_yet_paid';
      if (order.status === 'CANCELLED' || order.status === 'REFUNDED')
        return 'not_refundable';
      if (!(await this.history.has(orderId, 'partial_refund', actor)))
        await this.history.append({
          orderId,
          from: order.status,
          to: order.status,
          reason: 'partial_refund',
          actor,
          amountMinor: refundedMinor,
          at: this.clock.now(),
        });
      return 'partial_recorded';
    }
    const result = await this.lifecycle.transition(
      orderId,
      { type: 'refund', reason: 'provider_refund' },
      { actor },
    );
    switch (result.kind) {
      case 'applied':
        return 'refunded';
      case 'already_applied':
        return 'already_refunded';
      case 'not_found':
        return 'not_found';
      case 'invalid':
        if (
          result.order.status === 'RESERVED' ||
          result.order.status === 'PENDING'
        )
          return 'not_yet_paid';
        return 'not_refundable';
    }
  }
}
