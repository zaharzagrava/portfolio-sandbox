import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { noActiveSubscription } from '../domain/errors';
import {
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type InvoiceRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import type { Subject, SubscriptionDetail } from '../domain/types';
import { chargeJobKey } from './invoice-issuer.service';
import { SubscriptionQueryService } from './subscription-query.service';
import './billing.job-types';

/**
 * Replacing the payment-method reference (S17 FR-038). The reference is stored opaque. When the subscription is
 * `PAST_DUE` or `UNPAID`, ONE extra attempt (`<invoiceId>:manual:<k>`) is requested now on the oldest invoice still
 * owed; it neither shortens nor shifts the numbered schedule, and a success recovers the subscription. The attempt is
 * a job enqueued in the same transaction, so the provider is not called inside this request.
 */
@Injectable()
export class PaymentMethodService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly jobs: JobsService,
    private readonly queries: SubscriptionQueryService,
  ) {}

  async update(subject: Subject, ref: string): Promise<SubscriptionDetail> {
    const now = this.clock.now();
    const updated = await this.tx.run(async () => {
      const stored = await this.subscriptions.setPaymentMethodRef(
        subject,
        ref,
        now,
      );
      if (!stored) throw noActiveSubscription();
      const { status } = stored.subscription;
      if (status === 'PAST_DUE' || status === 'UNPAID') {
        const owed = await this.invoices.oldestOwed(stored.subscription.id);
        if (owed && !owed.attemptStartedAt) {
          const k = owed.manualAttempts + 1;
          await this.jobs.enqueue(
            'billing.manual-attempt',
            { invoiceId: owed.id, k },
            { idempotencyKey: chargeJobKey(owed.id, `manual:${k}`) },
          );
        }
      }
      return stored;
    });
    return this.queries.detailOf(updated);
  }
}
