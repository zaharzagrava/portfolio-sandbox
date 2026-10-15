import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  alreadyScheduledForCancellation,
  noActiveSubscription,
  notScheduledForCancellation,
  subscriptionChangedConcurrently,
} from '../domain/errors';
import {
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type InvoiceRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import type {
  Subject,
  SubscriptionDetail,
  SubscriptionView,
} from '../domain/types';
import { SubscriptionQueryService } from './subscription-query.service';
import { SubscriptionTransitions } from './subscription-transitions.service';

/** A guard that fails because someone else moved first is retried on fresh state this many times. */
const ATTEMPTS = 4;

/**
 * Cancel and resume (S17 FR-047). Cancelling at period end sets a flag and keeps access; cancelling now moves to
 * `CANCELED`, writes off unpaid `OPEN` invoices (they stay as records) and keeps the credit balance. Both are legal
 * from every live status, so a lost race is retried on the fresh row instead of failing the customer.
 */
@Injectable()
export class CancellationService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly transitions: SubscriptionTransitions,
    private readonly queries: SubscriptionQueryService,
  ) {}

  cancel(
    subject: Subject,
    input: { immediately?: boolean },
    actorUserId: string,
  ): Promise<SubscriptionDetail> {
    return this.attempt(subject, async (view, now) => {
      if (input.immediately) {
        const updated = await this.transitions.move(
          view,
          'cancelled_immediately',
          {
            reason: 'cancelled_by_customer',
            actor: { kind: 'user', id: actorUserId },
            at: now,
          },
          { canceledAt: now, cancelReason: 'customer' },
        );
        if (updated)
          await this.invoices.writeOffOpen(
            view.subscription.id,
            now,
            'subscription_canceled',
          );
        return updated;
      }
      if (view.subscription.cancelAtPeriodEnd)
        throw alreadyScheduledForCancellation();
      return this.transitions.keep(
        view,
        { cancelAtPeriodEnd: true, cancelReason: 'customer' },
        {
          reason: 'cancel_scheduled',
          actor: { kind: 'user', id: actorUserId },
          at: now,
        },
      );
    });
  }

  resume(subject: Subject, actorUserId: string): Promise<SubscriptionDetail> {
    return this.attempt(subject, (view, now) => {
      const { subscription } = view;
      // A cancellation scheduled by the shop's offboarding is not the customer's to withdraw.
      if (
        !subscription.cancelAtPeriodEnd ||
        subscription.cancelReason === 'shop_offboarding'
      )
        throw notScheduledForCancellation();
      return this.transitions.keep(
        view,
        { cancelAtPeriodEnd: false, cancelReason: null },
        {
          reason: 'cancel_withdrawn',
          actor: { kind: 'user', id: actorUserId },
          at: now,
        },
      );
    });
  }

  private async attempt(
    subject: Subject,
    work: (
      view: SubscriptionView,
      now: Date,
    ) => Promise<SubscriptionView | null>,
  ): Promise<SubscriptionDetail> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const updated = await this.tx.run(async () => {
        const view = await this.subscriptions.findLive(subject);
        if (!view) throw noActiveSubscription();
        return work(view, this.clock.now());
      });
      if (updated) return this.queries.detailOf(updated);
    }
    throw subscriptionChangedConcurrently();
  }
}
