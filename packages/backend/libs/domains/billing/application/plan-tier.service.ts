import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  INVOICE_REPOSITORY,
  PLAN_STATE_REPOSITORY,
  type InvoiceRepository,
  type PlanStateRepository,
} from '../domain/ports';
import { effectiveTier } from '../domain/tier';
import type { SubscriptionView } from '../domain/types';
import { SubscriptionPlanChanged } from './events/billing-events';

/**
 * The shop's announced plan tier (S17 FR-020, S03 contract). After any change of a shop's subscription, the effective
 * tier is compared with the per-shop counter in `SubjectPlanState`; only a real change emits
 * `billing.subscription_plan_changed {shopId, plan, version}`, inside the caller's transaction (outbox). Buyers have
 * no tier and never emit.
 */
@Injectable()
export class PlanTierService {
  constructor(
    @Inject(PLAN_STATE_REPOSITORY) private readonly state: PlanStateRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Whether the plan has been paid for (J02 G-13): a trial, a free price, or at least one paid invoice. Until then the
   * subscription exists but the shop is still on the free tier.
   */
  private async settled(view: SubscriptionView): Promise<boolean> {
    if (view.subscription.status === 'TRIALING') return true;
    if (view.price.unitAmountMinor === 0) return true;
    // a subscription with no invoice that asks for money has nothing unpaid to wait for
    return (
      (await this.invoices.countPaid(view.subscription.id)) > 0 ||
      (await this.invoices.countBilled(view.subscription.id)) === 0
    );
  }

  async sync(view: SubscriptionView, now: Date): Promise<void> {
    const { subscription, plan } = view;
    if (subscription.subjectType !== 'SHOP') return;
    const tier = effectiveTier(
      subscription.status,
      plan.code,
      await this.settled(view),
    );
    const version = await this.state.bump(
      { subjectType: 'SHOP', subjectId: subscription.subjectId },
      tier,
      now,
    );
    if (version === null) return;
    await this.outbox.append(
      SubscriptionPlanChanged.create(subscription.subjectId, version, {
        shopId: subscription.subjectId,
        plan: tier,
        version,
      }),
    );
  }
}
