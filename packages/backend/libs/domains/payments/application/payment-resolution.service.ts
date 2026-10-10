import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { unknownDelayMs } from '../domain/backoff';
import {
  providerMismatchCounter,
  unknownOldestAgeGauge,
} from '../domain/payment-metrics';
import {
  PAYMENT_PROVIDER,
  PAYMENT_REPOSITORY,
  RANDOM,
  type PaymentProvider,
  type PaymentRecord,
  type PaymentRepository,
} from '../domain/ports';
import { classifyLookup } from '../domain/provider-outcome';
import { PaymentTransitionService } from './payment-transition.service';

import './payment.job-types';

const ACTOR = 'system:resolver';
const HOUR_MS = 3_600_000;

export type ResolveResult =
  | 'noop'
  | 'completed'
  | 'failed'
  | 'customer_action'
  | 'rescheduled'
  | 'mismatch';

/**
 * Settles an `UNKNOWN` payment by asking the provider about OUR reference (the order id in the intent metadata), never
 * by sending the charge again (S13 US3, A10/A11/A26). Found and successful goes through the same guarded step as any
 * other success; found and failed fails; nothing found fails only 60 minutes after the attempt began; anything else
 * (the provider unreachable, an open breaker, an answer that contradicts our record) leaves the payment `UNKNOWN` and
 * schedules the next lookup with exponential backoff and full jitter. Past 24 hours the payment stays `UNKNOWN`
 * and raises an hourly alert.
 */
@Injectable()
export class PaymentResolutionService {
  private readonly logger = new Logger(PaymentResolutionService.name);

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

  async resolve(paymentId: string): Promise<ResolveResult> {
    const payment = await this.payments.findById(paymentId);
    if (!payment || payment.status !== 'UNKNOWN') return 'noop';

    const response = await this.provider.findIntentByReference(payment.orderId);
    const outcome = classifyLookup(response, {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      orderId: payment.orderId,
    });

    switch (outcome.kind) {
      case 'succeeded':
        await this.transitions.apply(paymentId, { type: 'succeed' }, ACTOR, {
          providerRef: outcome.providerRef,
        });
        return 'completed';
      case 'failed':
        await this.transitions.apply(
          paymentId,
          { type: 'fail', code: outcome.code },
          ACTOR,
        );
        return 'failed';
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
        return 'customer_action';
      case 'not_found': {
        const attemptedAt = payment.chargeAttemptedAt ?? payment.createdAt;
        const silentFor = this.clock.now().getTime() - attemptedAt.getTime();
        if (
          silentFor >=
          this.config.get('payments_resolve_no_record_seconds') * 1000
        ) {
          await this.transitions.apply(
            paymentId,
            { type: 'fail', code: 'no_provider_record' },
            ACTOR,
          );
          return 'failed';
        }
        await this.reschedule(payment);
        return 'rescheduled';
      }
      case 'mismatch':
        providerMismatchCounter.add(1, { field: outcome.field });
        this.logger.error(
          `provider answer for unknown payment ${paymentId} order ${payment.orderId} does not match our record (${outcome.field}); left UNKNOWN`,
        );
        await this.reschedule(payment);
        return 'mismatch';
      case 'pending':
      case 'unreachable':
        await this.reschedule(payment);
        return 'rescheduled';
    }
  }

  /**
   * Backstop for a lost resolution job: enqueues the lookup of every `UNKNOWN` payment whose time has come (at most
   * `payments_sweep_batch`, claimed with `SKIP LOCKED` in one short transaction, so two sweepers never take the same
   * payment; the job's idempotency key makes a repeat harmless) and refreshes the age gauge.
   */
  async sweepDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.runner.run(async () => {
      const claimed = await this.payments.claimDueUnknown(
        now,
        this.config.get('payments_sweep_batch'),
      );
      for (const payment of claimed)
        await this.jobs.enqueue(
          'payments.resolve-unknown',
          { paymentId: payment.id },
          {
            runAt: now,
            // Not the key of the job this backstop stands in for: that key is spent once its job was lost or died.
            idempotencyKey: `resolve-sweep:${payment.id}:${payment.resolveChecks}`,
          },
        );
      return claimed.length;
    });
    const oldest = await this.payments.oldestUnknownSince();
    unknownOldestAgeGauge.set(
      oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    );
    return due;
  }

  private async reschedule(payment: PaymentRecord): Promise<void> {
    const now = this.clock.now();
    const next = new Date(
      now.getTime() +
        unknownDelayMs(payment.resolveChecks, this.random, {
          baseMs: this.config.get('payments_resolve_first_delay_ms'),
          capMs: this.config.get('payments_resolve_backoff_cap_ms'),
        }),
    );
    const checks = payment.resolveChecks + 1;

    let alertedAt: Date | undefined;
    const since = payment.unknownSince ?? payment.createdAt;
    const ageMs = now.getTime() - since.getTime();
    if (ageMs > this.config.get('payments_stuck_seconds') * 1000) {
      unknownOldestAgeGauge.set(ageMs / 1000);
      if (
        !payment.lastStuckAlertAt ||
        now.getTime() - payment.lastStuckAlertAt.getTime() >= HOUR_MS
      ) {
        this.logger.warn(
          `payment ${payment.id} order ${payment.orderId} is stuck UNKNOWN for ${Math.floor(ageMs / HOUR_MS)} hours`,
        );
        alertedAt = now;
      }
    }

    await this.runner.run(async () => {
      await this.payments.rescheduleResolve(payment.id, {
        nextResolveAt: next,
        resolveChecks: checks,
        ...(alertedAt && { lastStuckAlertAt: alertedAt }),
      });
      await this.jobs.enqueue(
        'payments.resolve-unknown',
        { paymentId: payment.id },
        { runAt: next, idempotencyKey: `resolve:${payment.id}:${checks}` },
      );
    });
  }
}
