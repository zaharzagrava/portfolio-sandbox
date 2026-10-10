import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { chargeRetryAllowed, chargeRetryDelayMs } from '../domain/backoff';
import { checkPayable } from '../domain/order-copy';
import {
  providerMismatchCounter,
  providerCallsCounter,
} from '../domain/payment-metrics';
import {
  ORDER_COPY_REPOSITORY,
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  RANDOM,
  type OrderCopyRepository,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRepository,
} from '../domain/ports';
import { classifyCharge } from '../domain/provider-outcome';
import { PaymentTransitionService } from './payment-transition.service';

import './payment.job-types';

const ACTOR = 'system:processor';

export type ChargeResult =
  | 'missing'
  | 'noop'
  | 'crash_recovery'
  | 'order_not_payable'
  | 'succeeded'
  | 'declined'
  | 'rejected'
  | 'requires_action'
  | 'unknown'
  | 'retry_scheduled'
  | 'gave_up';

/**
 * The charge use case (S13 US2, A4/A8/A13): one idempotent `charge(paymentId, attempt)` for the queue command and the
 * retry job alike. The attempt is recorded by one conditional update before the provider is called; the call itself runs
 * outside any transaction; the answer is classified by pure code and applied as one guarded transition. An ambiguous
 * answer (timeout, `5xx`) or a recorded attempt that never got an answer is `UNKNOWN`, never re-sent. Only a call that
 * provably did not leave (open breaker, no connection, `429`) is retried, by this service's own jittered backoff.
 */
@Injectable()
export class PaymentChargeService {
  private readonly logger = new Logger(PaymentChargeService.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(ORDER_COPY_REPOSITORY)
    private readonly orderCopies: OrderCopyRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly transitions: PaymentTransitionService,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RANDOM) private readonly random: () => number,
  ) {}

  async charge(paymentId: string, _attempt = 0): Promise<ChargeResult> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) return 'missing';
    if (payment.status !== 'PENDING' || payment.requiresAction) return 'noop';

    // An attempt is recorded but the command came again: the answer was lost (crash, restart). Never send a second one.
    if (payment.chargeAttemptedAt) {
      await this.transitions.apply(
        paymentId,
        { type: 'markUnknown', reason: 'crash_recovery' },
        ACTOR,
      );
      return 'crash_recovery';
    }

    const copy = await this.orderCopies.find(payment.orderId);
    const payable = copy ? checkPayable(copy, this.clock.now()) : null;
    if (!payable?.payable) {
      await this.transitions.apply(
        paymentId,
        { type: 'cancel', reason: 'order_not_payable' },
        ACTOR,
      );
      return 'order_not_payable';
    }

    const attempts = await this.payments.startCharge(
      paymentId,
      this.clock.now(),
    );
    if (attempts === null) return 'noop'; // cancelled or started by someone else between the read and now

    const response = await this.provider.createIntent({
      paymentId,
      orderId: payment.orderId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      paymentMethodToken: payment.paymentMethodToken ?? '',
      referenceKey: payment.orderId,
    });
    const outcome = classifyCharge(response, {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      orderId: payment.orderId,
    });

    switch (outcome.kind) {
      case 'succeeded':
        await this.transitions.apply(paymentId, { type: 'succeed' }, ACTOR, {
          providerRef: outcome.providerRef,
        });
        return 'succeeded';
      case 'declined':
        await this.transitions.apply(
          paymentId,
          { type: 'fail', code: outcome.code },
          ACTOR,
        );
        return 'declined';
      case 'rejected':
        // A request the provider refused (bad key, bad request): our bug or configuration, not the customer's card.
        this.logger.error(
          `provider rejected the charge of payment ${paymentId} order ${payment.orderId}: http ${outcome.httpStatus} request ${outcome.requestId ?? 'n/a'}`,
        );
        providerCallsCounter.add(1, {
          operation: 'create_intent',
          outcome: 'rejected',
        });
        await this.transitions.apply(
          paymentId,
          { type: 'fail', code: 'provider_rejected' },
          ACTOR,
        );
        return 'rejected';
      case 'requires_action':
        await this.transitions.apply(
          paymentId,
          { type: 'awaitCustomer' },
          ACTOR,
          {
            providerRef: outcome.providerRef,
            clientSecret: outcome.clientSecret,
          },
        );
        return 'requires_action';
      case 'invalid':
        // The provider answered with something that does not match our record: do not trust it, settle by lookup.
        providerMismatchCounter.add(1, { field: outcome.field });
        this.logger.error(
          `provider answer for payment ${paymentId} order ${payment.orderId} does not match (${outcome.field})`,
        );
        await this.transitions.apply(
          paymentId,
          { type: 'markUnknown', reason: 'provider_response_invalid' },
          ACTOR,
        );
        return 'unknown';
      case 'ambiguous':
        await this.transitions.apply(
          paymentId,
          { type: 'markUnknown', reason: 'provider_timeout' },
          ACTOR,
        );
        return 'unknown';
      case 'not_sent':
        return this.notSent(payment, attempts);
    }
  }

  /** The call provably did not leave: forget the attempt and retry with full jitter, or give up at the cut-off. */
  private async notSent(
    payment: PaymentRecord,
    attempts: number,
  ): Promise<ChargeResult> {
    await this.payments.clearChargeMark(payment.id);
    const now = this.clock.now();
    const allowed = chargeRetryAllowed({
      attempts,
      createdAt: payment.createdAt,
      now,
      maxAttempts: this.config.get('payments_charge_max_attempts'),
      deadlineSeconds: this.config.get('payments_charge_deadline_seconds'),
    });
    if (!allowed) {
      await this.transitions.apply(
        payment.id,
        { type: 'fail', code: 'provider_unavailable' },
        ACTOR,
      );
      return 'gave_up';
    }
    const delay = chargeRetryDelayMs(attempts - 1, this.random, {
      baseMs: this.config.get('payments_charge_backoff_base_ms'),
      capMs: this.config.get('payments_charge_backoff_cap_ms'),
    });
    await this.jobs.enqueue(
      'payments.charge',
      { paymentId: payment.id, attempt: attempts },
      {
        runAt: new Date(now.getTime() + delay),
        idempotencyKey: `charge:${payment.id}:${attempts}`,
      },
    );
    return 'retry_scheduled';
  }
}
