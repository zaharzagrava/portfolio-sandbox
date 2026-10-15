import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { BILLING_LIMITS } from '../domain/config';
import { MAX_ATTEMPTS } from '../domain/dunning-schedule';
import {
  BILLING_GATEWAY,
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type AttemptKind,
  type BillingGateway,
  type InvoiceRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import { unknownAttemptsGauge } from '../domain/metrics';
import type { InvoiceRow } from '../domain/types';
import { AttemptSettlement } from './attempt-settlement.service';
import { chargeJobKey } from './invoice-issuer.service';
import './billing.job-types';

/**
 * Charging an invoice (S17 FR-031 to FR-037). Three steps, only the middle one outside a transaction: (1) CLAIM the
 * attempt with one conditional update — the invoice row, not the job, is the truth, so an early, duplicate or late
 * delivery claims nothing and calls nothing; (2) call the provider once, with a timeout and our reference; (3) SETTLE
 * with the same guarded step the lookup uses. An answer nobody can classify leaves the attempt claimed and unknown and
 * is resolved by looking it up — a charge is never sent again for an attempt number already claimed.
 */
@Injectable()
export class ChargeService {
  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly settlement: AttemptSettlement,
  ) {}

  /** Job `billing.charge-invoice`: the next numbered attempt of the invoice, if it is due. */
  chargeInvoice(invoiceId: string): Promise<void> {
    return this.claimAndCharge(invoiceId, { type: 'numbered' });
  }

  /** Job `billing.manual-attempt`: the one extra attempt after the customer changed the payment method. */
  manualAttempt(invoiceId: string, k: number): Promise<void> {
    return this.claimAndCharge(invoiceId, { type: 'manual', k });
  }

  private async claimAndCharge(
    invoiceId: string,
    kind: AttemptKind,
  ): Promise<void> {
    const now = this.clock.now();
    const before = await this.invoices.findById(invoiceId);
    if (!before) return;
    const view = await this.subscriptions.findById(before.subscriptionId);
    // A cancelled subscription is never charged again (FR-018); cancelling already wrote its open invoices off.
    if (!view || view.subscription.status === 'CANCELED') return;

    const claimed = await this.tx.run(() =>
      this.invoices.claimAttempt(invoiceId, kind, now),
    );
    if (!claimed) {
      await this.unclaimed(invoiceId, kind, now);
      return;
    }
    await this.charge(claimed);
  }

  private async charge(invoice: InvoiceRow): Promise<void> {
    const attemptRef = invoice.attemptRef as string;
    const paymentMethodRef = await this.subscriptions.paymentMethodRefOf(
      invoice.subscriptionId,
    );
    if (!paymentMethodRef) {
      await this.settlement.failed(invoice, attemptRef, 'no_payment_method');
      return;
    }
    const outcome = await this.gateway.charge({
      invoiceId: invoice.id,
      subscriptionId: invoice.subscriptionId,
      attemptRef,
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      paymentMethodRef,
      timeoutMs: BILLING_LIMITS.providerTimeoutMs,
    });
    switch (outcome.kind) {
      case 'succeeded':
        await this.settlement.paid(invoice, attemptRef);
        return;
      case 'declined':
      case 'authentication_required':
        await this.settlement.failed(invoice, attemptRef, outcome.reason);
        return;
      case 'unknown':
        await this.settlement.unknown(invoice, attemptRef, outcome.reason);
        unknownAttemptsGauge.set(await this.invoices.countUnknownAttempts());
        return;
    }
  }

  /** Nothing was claimed: say why, and fix what can be fixed (an early delivery, a crashed claim). */
  private async unclaimed(
    invoiceId: string,
    kind: AttemptKind,
    now: Date,
  ): Promise<void> {
    const invoice = await this.invoices.findById(invoiceId);
    if (!invoice) return;
    if (invoice.attemptStartedAt) {
      await this.settlement.checkStaleClaim(invoice, now);
      return;
    }
    if (
      kind.type === 'numbered' &&
      invoice.status === 'OPEN' &&
      invoice.attempts < MAX_ATTEMPTS &&
      invoice.nextAttemptAt &&
      invoice.nextAttemptAt.getTime() > now.getTime()
    ) {
      // Delivered early: do nothing now and ask to run at the due time (a key per due time, so repeats collapse).
      await this.jobs.enqueue(
        'billing.charge-invoice',
        { invoiceId },
        {
          runAt: invoice.nextAttemptAt,
          idempotencyKey: `${chargeJobKey(invoiceId, invoice.attempts + 1)}:at:${invoice.nextAttemptAt.getTime()}`,
        },
      );
    }
  }
}
