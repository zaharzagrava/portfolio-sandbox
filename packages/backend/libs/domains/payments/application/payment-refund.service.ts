import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { fullJitterMs } from '../domain/backoff';
import {
  consumerDeadLetteredCounter,
  refundPendingOldestAgeGauge,
  refundRequestsCounter,
  refundStuckCounter,
} from '../domain/payment-metrics';
import {
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  RANDOM,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRepository,
} from '../domain/ports';
import { classifyRefund, classifyRefundLookup } from '../domain/refund-outcome';
import { PaymentTransitionService } from './payment-transition.service';

import './payment.job-types';

const ACTOR = 'system:refund';

export type RefundResult =
  | 'missing'
  | 'noop'
  | 'nothing_to_refund'
  | 'waiting'
  | 'wait_expired'
  | 'refunded'
  | 'retry_scheduled'
  | 'stuck';

/**
 * Executes the refund of a payment (S13 US6, A17, FR-036/FR-037). The refund command only moves a completed payment to
 * `REFUND_PENDING` and queues this job; the job asks the provider whether the refund already exists before it sends one
 * (never a blind resend), counts "already refunded" as done, retries what is uncertain with jittered backoff (cap 15
 * minutes) and stops, loudly, on a hard refusal or after the 24-hour window. A payment that is not settled yet waits as a
 * job too (a queue message would be dead-lettered long before 24 hours); each run re-reads the state. Money moves back in
 * the ledger in the same transaction as the `REFUNDED` status.
 */
@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly transitions: PaymentTransitionService,
    private readonly jobs: JobsService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: () => number,
  ) {}

  async execute(paymentId: string): Promise<RefundResult> {
    let payment = await this.payments.findById(paymentId);
    if (!payment) return 'missing';

    switch (payment.status) {
      case 'REFUNDED':
        return 'noop';
      case 'FAILED':
      case 'CANCELLED':
        refundRequestsCounter.add(1, { result: 'nothing_to_refund' });
        return 'nothing_to_refund';
      case 'PENDING':
      case 'UNKNOWN':
        return this.wait(payment);
      case 'COMPLETED': {
        const moved = await this.transitions.apply(
          paymentId,
          { type: 'requestRefund' },
          ACTOR,
        );
        if (moved.kind === 'not_found') return 'missing';
        payment = moved.payment;
        if (payment.status !== 'REFUND_PENDING') return this.execute(paymentId);
        break;
      }
      case 'REFUND_PENDING':
        break;
    }
    return this.refundAtProvider(payment);
  }

  /** Enqueues the execution of a payment's refund (the command's job). */
  async schedule(paymentId: string, runAt: Date, key: string): Promise<void> {
    await this.jobs.enqueue(
      'payments.refund',
      { paymentId },
      { runAt, idempotencyKey: key },
    );
  }

  /** The first request on a payment that cannot be refunded yet: remember when, and wait. */
  async startWaiting(payment: PaymentRecord): Promise<void> {
    await this.wait(payment);
  }

  /**
   * Backstop for a lost refund job: enqueues every `REFUND_PENDING` payment whose time has come (at most
   * `payments_refund_batch`) and refreshes the age gauge.
   */
  async sweepDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.runner.run(async () => {
      const claimed = await this.payments.claimDueRefunds(
        now,
        this.config.get('payments_refund_batch'),
      );
      for (const payment of claimed)
        await this.schedule(
          payment.id,
          now,
          `refund-sweep:${payment.id}:${payment.refundNextAt?.getTime() ?? 0}`,
        );
      return claimed.length;
    });
    await this.updateAgeGauge(now);
    return due;
  }

  private async wait(payment: PaymentRecord): Promise<RefundResult> {
    const now = this.clock.now();
    const requestedAt = payment.refundRequestedAt ?? now;
    if (
      now.getTime() - requestedAt.getTime() >=
      this.config.get('payments_refund_window_seconds') * 1000
    ) {
      consumerDeadLetteredCounter.add(1, { reason: 'refund_wait_expired' });
      this.logger.error(
        `refund of payment ${payment.id} order ${payment.orderId} waited 24 hours for the payment to settle (${payment.status}); giving up`,
      );
      return 'wait_expired';
    }
    const next = new Date(now.getTime() + this.delayFor(now, requestedAt));
    await this.runner.run(async () => {
      await this.payments.markRefundRequested(payment.id, now, next);
      await this.schedule(
        payment.id,
        next,
        `refund-wait:${payment.id}:${next.getTime()}`,
      );
    });
    return 'waiting';
  }

  private async refundAtProvider(
    payment: PaymentRecord,
  ): Promise<RefundResult> {
    const now = this.clock.now();
    const requestedAt = payment.refundRequestedAt ?? payment.updatedAt;
    if (
      now.getTime() - requestedAt.getTime() >=
      this.config.get('payments_refund_window_seconds') * 1000
    )
      return this.stuck(payment, 'the 24-hour window has passed');
    if (!payment.providerRef)
      return this.stuck(payment, 'the payment has no provider reference');

    // Look before sending: a refund that exists (an answer lost on the way back) is finished, not repeated.
    const lookup = classifyRefundLookup(
      await this.provider.findRefunds(payment.providerRef),
      payment.amountMinor,
    );
    if (lookup.kind === 'exists') return this.finish(payment);
    if (lookup.kind === 'retry') return this.retryLater(payment, requestedAt);

    const response = await this.provider.createRefund(
      payment.providerRef,
      `refund:${payment.id}`,
    );
    const outcome = classifyRefund(response);
    switch (outcome.kind) {
      case 'done':
      case 'already_refunded':
        return this.finish(payment);
      case 'refused':
        return this.stuck(
          payment,
          `the provider refused it (http ${outcome.httpStatus}, request ${(outcome as { requestId?: string }).requestId ?? 'n/a'})`,
        );
      case 'retry':
        return this.retryLater(payment, requestedAt);
    }
  }

  private async finish(payment: PaymentRecord): Promise<RefundResult> {
    await this.transitions.apply(
      payment.id,
      { type: 'refundSucceeded' },
      ACTOR,
    );
    return 'refunded';
  }

  private async retryLater(
    payment: PaymentRecord,
    requestedAt: Date,
  ): Promise<RefundResult> {
    const now = this.clock.now();
    const next = new Date(now.getTime() + this.delayFor(now, requestedAt));
    if (
      next.getTime() - requestedAt.getTime() >=
      this.config.get('payments_refund_window_seconds') * 1000
    )
      return this.stuck(
        payment,
        'the next attempt would be past the 24-hour window',
      );
    await this.runner.run(async () => {
      await this.payments.rescheduleRefund(payment.id, next);
      await this.schedule(
        payment.id,
        next,
        `refund-retry:${payment.id}:${next.getTime()}`,
      );
    });
    return 'retry_scheduled';
  }

  private async stuck(
    payment: PaymentRecord,
    why: string,
  ): Promise<RefundResult> {
    refundStuckCounter.add();
    this.logger.error(
      `refund of payment ${payment.id} order ${payment.orderId} is stuck: ${why}`,
    );
    await this.payments.rescheduleRefund(payment.id, null); // nothing is due: an operator looks at it
    await this.updateAgeGauge(this.clock.now());
    return 'stuck';
  }

  /** Full jitter whose bound grows with the age of the request (30 s doubling to the 15-minute cap). */
  private delayFor(now: Date, requestedAt: Date): number {
    const base = this.config.get('payments_refund_backoff_base_ms');
    const age = Math.max(0, now.getTime() - requestedAt.getTime());
    const attempt = Math.floor(Math.log2(Math.max(1, age / base)));
    return Math.max(
      1_000,
      fullJitterMs(attempt, this.random, {
        baseMs: base,
        capMs: this.config.get('payments_refund_backoff_cap_ms'),
      }),
    );
  }

  private async updateAgeGauge(now: Date): Promise<void> {
    const oldest = await this.payments.oldestRefundPendingSince();
    refundPendingOldestAgeGauge.set(
      oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    );
  }
}
