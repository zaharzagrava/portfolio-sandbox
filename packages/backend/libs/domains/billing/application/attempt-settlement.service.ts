import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { BILLING_LIMITS } from '../domain/config';
import { MAX_ATTEMPTS, nextAttemptAt } from '../domain/dunning-schedule';
import {
  chargeAttemptsCounter,
  invoicesPaidCounter,
  dunningExhaustedCounter,
} from '../domain/metrics';
import {
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type InvoiceRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import type { InvoiceRow, SubscriptionView } from '../domain/types';
import { InvoicePaid, InvoicePaymentFailed } from './events/billing-events';
import { chargeJobKey } from './invoice-issuer.service';
import { SubscriptionTransitions } from './subscription-transitions.service';
import './billing.job-types';

export const resolveJobKey = (
  invoiceId: string,
  attemptRef: string,
  round: number,
) => `resolve-attempt:${invoiceId}:${attemptRef}:${round}`;

/** A definite failure: a reason the dunning path and the customer's mail can show. */
export type FailureReason = string;

/**
 * What happens when an attempt's outcome is known (S17 FR-032 to FR-035, FR-019), shared by the charge job and the
 * lookup that settles an unknown attempt: the SAME guarded step either way, so the result is applied once.
 * Each method is one transaction: the invoice move, its history row, the events and the subscription's move commit
 * together or not at all. `false` means the attempt had already been settled (or the guard lost a race): no effect.
 */
@Injectable()
export class AttemptSettlement {
  private readonly logger = new Logger(AttemptSettlement.name);

  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly outbox: OutboxService,
    private readonly transitions: SubscriptionTransitions,
  ) {}

  async paid(invoice: InvoiceRow, attemptRef: string): Promise<boolean> {
    const now = this.clock.now();
    const done = await this.tx.run(async () => {
      // Lock order everywhere: the subscription first, then its invoices (a cancel and a settle can meet).
      const view = await this.subscriptions.lockForRenewal(
        invoice.subscriptionId,
      );
      const settled = await this.invoices.settlePaid(
        invoice.id,
        attemptRef,
        now,
      );
      if (!settled) return false;
      if (!view) return true;
      const { subscription } = view;
      await this.outbox.append(
        InvoicePaid.create(subscription.subjectId, settled.attempts, {
          invoiceId: settled.id,
          subscriptionId: subscription.id,
          subjectType: subscription.subjectType,
          subjectId: subscription.subjectId,
          kind: settled.kind,
          totalMinor: settled.totalMinor,
          currency: settled.currency,
          periodStart: settled.periodStart.toISOString(),
          periodEnd: settled.periodEnd.toISOString(),
          paidAt: (settled.paidAt ?? now).toISOString(),
        }),
      );
      await this.recover(view, now);
      // the first money taken for a plan: the paid entitlements and tier start here, announced by an event (J02 G-13)
      if (
        subscription.status === 'ACTIVE' &&
        (await this.invoices.countPaid(subscription.id)) === 1
      )
        await this.transitions.firstChargeSettled(view, now);
      return true;
    });
    if (done) {
      chargeAttemptsCounter.add(1, { outcome: 'succeeded' });
      invoicesPaidCounter.add(1);
    }
    return done;
  }

  /** The subscription returns to `ACTIVE` only when no invoice of it remains owed (FR-019). */
  private async recover(view: SubscriptionView, now: Date): Promise<void> {
    const { subscription } = view;
    if (subscription.status !== 'PAST_DUE' && subscription.status !== 'UNPAID')
      return;
    if ((await this.invoices.countOwed(subscription.id)) > 0) return;
    await this.transitions.move(
      view,
      subscription.status === 'PAST_DUE' ? 'dunning_paid' : 'unpaid_paid',
      {
        reason: 'invoice_paid',
        actor: { kind: 'system', name: 'dunning' },
        at: now,
      },
    );
  }

  async failed(
    invoice: InvoiceRow,
    attemptRef: string,
    reason: FailureReason,
  ): Promise<boolean> {
    const now = this.clock.now();
    const manual = attemptRef.startsWith('manual:');
    const done = await this.tx.run(async () => {
      // Lock order everywhere: the subscription first, then its invoices (a cancel and a settle can meet).
      const view = await this.subscriptions.lockForRenewal(
        invoice.subscriptionId,
      );
      const failedAttempt = manual ? invoice.attempts : Number(attemptRef);
      const firstFailedAt = invoice.firstFailedAt ?? now;
      const next = manual ? null : nextAttemptAt(firstFailedAt, failedAttempt);
      const exhausted = !manual && failedAttempt >= MAX_ATTEMPTS;
      const settled = await this.invoices.settleFailed(invoice.id, {
        attemptRef,
        now,
        firstFailedAt,
        nextAttemptAt: next,
        uncollectible: exhausted,
      });
      if (!settled) return false;
      if (manual) return true;
      if (!view) return true;
      const { subscription } = view;
      await this.outbox.append(
        InvoicePaymentFailed.create(subscription.subjectId, failedAttempt, {
          invoiceId: settled.id,
          subscriptionId: subscription.id,
          subjectType: subscription.subjectType,
          subjectId: subscription.subjectId,
          attempt: failedAttempt,
          nextAttemptAt: next ? next.toISOString() : null,
          reason,
          totalMinor: settled.totalMinor,
          currency: settled.currency,
        }),
      );
      const actor = { kind: 'system', name: 'dunning' } as const;
      if (subscription.status === 'ACTIVE')
        await this.transitions.move(view, 'first_charge_failed', {
          reason: 'payment_failed',
          actor,
          at: now,
        });
      else if (subscription.status === 'PAST_DUE' && exhausted)
        await this.transitions.move(view, 'dunning_exhausted', {
          reason: 'dunning_exhausted',
          actor,
          at: now,
        });
      if (next)
        await this.jobs.enqueue(
          'billing.charge-invoice',
          { invoiceId: settled.id },
          {
            runAt: next,
            idempotencyKey: chargeJobKey(settled.id, failedAttempt + 1),
          },
        );
      return true;
    });
    if (done) {
      chargeAttemptsCounter.add(1, {
        outcome:
          reason === 'authentication_required' || reason === 'no_payment_method'
            ? reason
            : 'declined',
      });
      if (!manual && Number(attemptRef) >= MAX_ATTEMPTS)
        dunningExhaustedCounter.add(1);
    }
    return done;
  }

  /**
   * A claim with no result for longer than the call timeout means the process died between the provider call and the
   * settle: the attempt becomes unknown and is resolved by lookup. An already unknown one only makes sure its
   * resolution job exists (same key, so no second job).
   */
  async checkStaleClaim(invoice: InvoiceRow, now: Date): Promise<void> {
    if (!invoice.attemptStartedAt || !invoice.attemptRef) return;
    const attemptRef = invoice.attemptRef;
    if (invoice.attemptUnknown) {
      await this.jobs.enqueue(
        'billing.resolve-attempt',
        { invoiceId: invoice.id, attempt: attemptRef, round: 0 },
        {
          runAt: new Date(
            now.getTime() + BILLING_LIMITS.firstResolutionDelayMs,
          ),
          idempotencyKey: resolveJobKey(invoice.id, attemptRef, 0),
        },
      );
      return;
    }
    if (
      now.getTime() - invoice.attemptStartedAt.getTime() >=
      BILLING_LIMITS.claimTimeoutMs
    )
      await this.unknown(invoice, attemptRef, 'stale_claim');
  }

  /** The provider gave no answer we can use: keep the claim, flag it, and have the lookup settle it later. */
  async unknown(
    invoice: InvoiceRow,
    attemptRef: string,
    reason: string,
  ): Promise<void> {
    const now = this.clock.now();
    await this.tx.run(async () => {
      if (!(await this.invoices.markUnknown(invoice.id, attemptRef, now)))
        return;
      const runAt = new Date(
        now.getTime() + BILLING_LIMITS.firstResolutionDelayMs,
      );
      await this.jobs.enqueue(
        'billing.resolve-attempt',
        { invoiceId: invoice.id, attempt: attemptRef, round: 0 },
        {
          runAt,
          idempotencyKey: resolveJobKey(invoice.id, attemptRef, 0),
        },
      );
    });
    chargeAttemptsCounter.add(1, { outcome: 'unknown' });
    this.logger.warn(
      `charge outcome unknown for invoice ${invoice.id} attempt ${attemptRef}: ${reason}`,
    );
  }
}
