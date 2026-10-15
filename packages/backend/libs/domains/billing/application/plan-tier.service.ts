import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  PLAN_STATE_REPOSITORY,
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
    private readonly outbox: OutboxService,
  ) {}

  async sync(view: SubscriptionView, now: Date): Promise<void> {
    const { subscription, plan } = view;
    if (subscription.subjectType !== 'SHOP') return;
    const tier = effectiveTier(subscription.status, plan.code);
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
