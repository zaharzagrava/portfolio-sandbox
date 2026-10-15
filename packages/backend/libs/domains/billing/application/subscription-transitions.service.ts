import { Inject, Injectable } from '@nestjs/common';
import { afterCommit } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  SUBSCRIPTION_REPOSITORY,
  type SubscriptionPatch,
  type SubscriptionRepository,
} from '../domain/ports';
import {
  transition,
  type TransitionTrigger,
} from '../domain/subscription-status';
import type { SubscriptionStatus } from '../domain/subscription-status';
import type { Actor, SubscriptionView } from '../domain/types';
import { EntitlementsService } from './entitlements.service';
import { SubscriptionStatusChanged } from './events/billing-events';
import { PlanTierService } from './plan-tier.service';

export interface Step {
  /** The status the subscription ends in; equal to the current one for a change that is not a status move. */
  to: SubscriptionStatus;
  reason: string;
  actor: Actor;
  at: Date;
}

/**
 * The one place a subscription row changes after it exists (S17 FR-016): a version-guarded update, one history row,
 * the status event (when the status really moved), the plan-tier event (shops, when the tier changed), and the
 * entitlement cache forgotten after the transaction commits. Must be called inside `TransactionRunner.run`.
 * `null` means the guard failed: someone else moved the subscription first.
 */
@Injectable()
export class SubscriptionTransitions {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    private readonly outbox: OutboxService,
    private readonly tiers: PlanTierService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** A status move named by its trigger; the table decides whether it is legal. */
  async move(
    current: SubscriptionView,
    trigger: TransitionTrigger,
    step: Omit<Step, 'to'>,
    patch: SubscriptionPatch = {},
  ): Promise<SubscriptionView | null> {
    const result = transition(current.subscription.status, trigger);
    if (!result.ok) return null;
    return this.apply(
      current,
      { ...patch, status: result.to },
      {
        ...step,
        to: result.to,
      },
    );
  }

  /** A change that keeps the status (price, quantity, period, cancellation flag): history `from = to`. */
  keep(
    current: SubscriptionView,
    patch: SubscriptionPatch,
    step: Omit<Step, 'to'>,
  ): Promise<SubscriptionView | null> {
    return this.apply(current, patch, {
      ...step,
      to: current.subscription.status,
    });
  }

  private async apply(
    current: SubscriptionView,
    patch: SubscriptionPatch,
    step: Step,
  ): Promise<SubscriptionView | null> {
    const { subscription } = current;
    const updated = await this.subscriptions.applyUpdate(
      subscription.id,
      { version: subscription.version, status: subscription.status },
      patch,
      {
        from: subscription.status,
        to: step.to,
        reason: step.reason,
        actor: step.actor,
        at: step.at,
      },
    );
    if (!updated) return null;
    if (subscription.status !== step.to)
      await this.outbox.append(
        SubscriptionStatusChanged.create(
          subscription.subjectId,
          updated.subscription.version,
          {
            subscriptionId: subscription.id,
            subjectType: subscription.subjectType,
            subjectId: subscription.subjectId,
            status: step.to,
            from: subscription.status,
            planCode: updated.plan.code,
            subscriptionVersion: updated.subscription.version,
          },
        ),
      );
    await this.tiers.sync(updated, step.at);
    this.forgetEntitlements(updated);
    return updated;
  }

  /** The events of a subscription that was just inserted (`from` is null). */
  async announceNew(view: SubscriptionView, at: Date): Promise<void> {
    const { subscription } = view;
    await this.outbox.append(
      SubscriptionStatusChanged.create(
        subscription.subjectId,
        subscription.version,
        {
          subscriptionId: subscription.id,
          subjectType: subscription.subjectType,
          subjectId: subscription.subjectId,
          status: subscription.status,
          from: null,
          planCode: view.plan.code,
          subscriptionVersion: subscription.version,
        },
      ),
    );
    await this.tiers.sync(view, at);
    this.forgetEntitlements(view);
  }

  /** The cache is dropped after the commit, never inside the transaction (S17 FR-011). */
  forgetEntitlements(view: SubscriptionView): void {
    const { subjectType, subjectId, id, version } = view.subscription;
    // version guarded: a load that began before this commit never stores its (older) result; a failure is logged by
    // `afterCommit` and the status event invalidates again (S18 FR-011, FR-014)
    afterCommit(() =>
      this.entitlements.invalidate(subjectType, subjectId, {
        subscriptionId: id,
        subscriptionVersion: version,
      }),
    );
  }
}
