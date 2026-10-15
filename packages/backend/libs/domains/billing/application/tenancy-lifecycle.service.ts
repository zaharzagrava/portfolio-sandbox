import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type InvoiceRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import type { Actor, Subject } from '../domain/types';
import { SubscriptionTransitions } from './subscription-transitions.service';

export type LifecycleEffect = 'applied' | 'ignored';

/**
 * What a shop's lifecycle does to its subscription (S17 FR-048, AS-75, AS-76). Every method runs in ONE transaction
 * the caller opens together with the inbox claim, so a duplicate delivery changes nothing and a crash applies nothing.
 *  - offboarding started: cancel at period end, reason `shop_offboarding`, remembering when it started;
 *  - offboarding cancelled: withdraw only that cancellation, and only if the event is newer than the start;
 *  - deleted: cancel now, erase the stored payment reference, keep invoices, lines and histories.
 */
@Injectable()
export class TenancyLifecycleService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly transitions: SubscriptionTransitions,
  ) {}

  private shop(shopId: string): Subject {
    return { subjectType: 'SHOP', subjectId: shopId };
  }

  private eventActor(eventId: string): Actor {
    return { kind: 'event', id: eventId };
  }

  offboardingStarted(
    shopId: string,
    eventId: string,
    occurredAt: Date,
  ): Promise<LifecycleEffect> {
    return this.tx.run(async () => {
      const view = await this.subscriptions.findLive(this.shop(shopId));
      if (!view || view.subscription.cancelAtPeriodEnd) return 'ignored';
      const updated = await this.transitions.keep(
        view,
        {
          cancelAtPeriodEnd: true,
          cancelReason: 'shop_offboarding',
          offboardingStartedAt: occurredAt,
        },
        {
          reason: 'shop_offboarding',
          actor: this.eventActor(eventId),
          at: this.clock.now(),
        },
      );
      return updated ? 'applied' : 'ignored';
    });
  }

  offboardingCancelled(
    shopId: string,
    eventId: string,
    occurredAt: Date,
  ): Promise<LifecycleEffect> {
    return this.tx.run(async () => {
      const view = await this.subscriptions.findLive(this.shop(shopId));
      if (!view) return 'ignored';
      const { subscription } = view;
      // Only the cancellation the offboarding scheduled, and only an event newer than the recorded start.
      if (
        !subscription.cancelAtPeriodEnd ||
        subscription.cancelReason !== 'shop_offboarding' ||
        (subscription.offboardingStartedAt &&
          occurredAt.getTime() <= subscription.offboardingStartedAt.getTime())
      )
        return 'ignored';
      const updated = await this.transitions.keep(
        view,
        {
          cancelAtPeriodEnd: false,
          cancelReason: null,
          offboardingStartedAt: null,
        },
        {
          reason: 'cancel_withdrawn',
          actor: this.eventActor(eventId),
          at: this.clock.now(),
        },
      );
      return updated ? 'applied' : 'ignored';
    });
  }

  deleted(shopId: string, eventId: string): Promise<LifecycleEffect> {
    return this.tx.run(async () => {
      const now = this.clock.now();
      const subject = this.shop(shopId);
      const view = await this.subscriptions.findLive(subject);
      let effect: LifecycleEffect = 'ignored';
      if (view) {
        const updated = await this.transitions.move(
          view,
          'shop_deleted',
          { reason: 'shop_deleted', actor: this.eventActor(eventId), at: now },
          {
            canceledAt: now,
            cancelReason: 'shop_deleted',
            paymentMethodRef: null,
          },
        );
        if (updated) {
          await this.invoices.writeOffOpen(
            view.subscription.id,
            now,
            'shop_deleted',
          );
          effect = 'applied';
        }
      }
      // Also for subscriptions cancelled earlier: no payment reference outlives the shop.
      if ((await this.subscriptions.eraseCredentials(subject, now)) > 0)
        effect = 'applied';
      return effect;
    });
  }
}
