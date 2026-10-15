import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { BILLING_LIMITS } from '../domain/config';
import {
  overdueSubscriptionsGauge,
  renewalDeferredCounter,
  renewalFailedCounter,
  renewalsCounter,
} from '../domain/metrics';
import { lineAmount } from '../domain/money';
import { addPeriod } from '../domain/periods';
import {
  INVOICE_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  USAGE_LINES_PROVIDER,
  type InvoiceRepository,
  type SubscriptionRepository,
  type UsageInvoiceLinesProvider,
  type UsageLine,
} from '../domain/ports';
import type { InvoiceLineRow, SubscriptionRow } from '../domain/types';
import { InvoiceIssuer } from './invoice-issuer.service';
import { SubscriptionTransitions } from './subscription-transitions.service';

type Outcome = 'invoiced' | 'canceled' | 'expired' | 'deferred' | 'skipped';

export type RenewalAction =
  'renew' | 'cancel_at_period_end' | 'expire_unpaid' | 'none';

/** Test seam (VII.9): a fault injected after the Nth subscription of a run committed, to prove a crash resumes. */
export interface RenewalFault {
  afterSubscription?(count: number): void;
}
export const RENEWAL_FAULT = Symbol('RENEWAL_FAULT');

export interface RunSummary {
  examined: number;
  invoiced: number;
  canceled: number;
  expired: number;
  deferred: number;
  skipped: number;
  failed: number;
}

/** What the run must do with a subscription at `now`; pure, evaluated before and again under the row lock. */
export function decide(sub: SubscriptionRow, now: Date): RenewalAction {
  const ended = sub.currentPeriodEnd.getTime() <= now.getTime();
  if (sub.status === 'CANCELED') return 'none';
  if (ended && sub.cancelAtPeriodEnd) return 'cancel_at_period_end';
  if (
    sub.status === 'UNPAID' &&
    sub.statusSince.getTime() <= now.getTime() - BILLING_LIMITS.unpaidExpiryMs
  )
    return 'expire_unpaid';
  if (ended && (sub.status === 'TRIALING' || sub.status === 'ACTIVE'))
    return 'renew';
  return 'none';
}

/**
 * The billing run (S17 FR-021 to FR-028). One run looks at most 500 due subscriptions, oldest period end first, and
 * handles each in its own transaction: the row is locked and the decision re-checked under the lock, so two runs, a
 * change at the boundary or a crash never double-bill or skip. The usage lines (S18) are fetched BEFORE the
 * transaction with a timeout; when they are unavailable the subscription is deferred whole, never invoiced without
 * them. A failure on one subscription is logged and counted and never stops the others.
 */
@Injectable()
export class RenewalService {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(USAGE_LINES_PROVIDER)
    private readonly usage: UsageInvoiceLinesProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RENEWAL_FAULT) private readonly fault: RenewalFault,
    private readonly tx: TransactionRunner,
    private readonly issuer: InvoiceIssuer,
    private readonly transitions: SubscriptionTransitions,
  ) {}

  async run(isStopping: () => boolean = () => false): Promise<RunSummary> {
    const now = this.clock.now();
    const summary: RunSummary = {
      examined: 0,
      invoiced: 0,
      canceled: 0,
      expired: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
    };
    const ids = await this.subscriptions.listDueIds(
      now,
      new Date(now.getTime() - BILLING_LIMITS.unpaidExpiryMs),
      BILLING_LIMITS.runBatch,
    );
    let handled = 0;
    for (const id of ids) {
      if (isStopping()) break;
      summary.examined++;
      try {
        const outcome = await this.handle(id, now);
        summary[outcome]++;
      } catch (error) {
        summary.failed++;
        renewalFailedCounter.add(1);
        this.logger.error(
          `renewal of subscription ${id} failed: ${(error as Error).message}`,
        );
      }
      handled++;
      this.fault.afterSubscription?.(handled);
    }
    overdueSubscriptionsGauge.set(
      await this.subscriptions.countOverdue(
        new Date(now.getTime() - BILLING_LIMITS.overdueAfterMs),
      ),
    );
    return summary;
  }

  private async handle(id: string, now: Date): Promise<Outcome> {
    const before = await this.subscriptions.findById(id);
    if (!before) return 'skipped';
    const planned = decide(before.subscription, now);
    if (planned === 'none') {
      renewalsCounter.add(1, { outcome: 'already_renewed' });
      return 'skipped';
    }

    // Outside any transaction: the usage lines of the period that ended (S18, bounded).
    let usageLines: UsageLine[] | null = null;
    if (planned === 'renew' && before.subscription.subjectType === 'SHOP') {
      try {
        usageLines = (
          await this.usage.linesFor({
            subscriptionId: id,
            subjectId: before.subscription.subjectId,
            priceId: before.subscription.priceId,
            periodStart: before.subscription.currentPeriodStart,
            periodEnd: before.subscription.currentPeriodEnd,
            measuredAt: now,
            timeoutMs: BILLING_LIMITS.usageTimeoutMs,
          })
        ).lines;
      } catch (error) {
        renewalDeferredCounter.add(1, { reason: 'usage_unavailable' });
        this.logger.warn(
          `renewal of subscription ${id} deferred: usage lines unavailable (${(error as Error).message})`,
        );
        return 'deferred';
      }
    }

    const outcome = await this.tx.run<Outcome>(async () => {
      const view = await this.subscriptions.lockForRenewal(id);
      if (!view) return 'skipped';
      const action = decide(view.subscription, now);
      const { subscription, price, plan } = view;
      const actor = { kind: 'system', name: 'billing-run' } as const;

      if (action === 'none') return 'skipped';

      if (action === 'cancel_at_period_end' || action === 'expire_unpaid') {
        const reason =
          action === 'expire_unpaid'
            ? 'unpaid_expired'
            : 'cancel_at_period_end';
        const moved = await this.transitions.move(
          view,
          action === 'expire_unpaid'
            ? 'unpaid_expired'
            : 'period_ended_with_cancellation',
          { reason, actor, at: now },
          {
            canceledAt: now,
            cancelReason: subscription.cancelReason ?? reason,
          },
        );
        if (!moved) return 'skipped';
        await this.invoices.writeOffOpen(subscription.id, now, reason);
        return action === 'expire_unpaid' ? 'expired' : 'canceled';
      }

      // renew: the period that ended is billed once, under its business key.
      if (subscription.subjectType === 'SHOP' && usageLines === null)
        return 'deferred';
      const start = subscription.currentPeriodEnd;
      const end = addPeriod(
        start,
        price.interval,
        subscription.billingAnchorDay,
      );
      const lines: InvoiceLineRow[] = [
        {
          kind: 'PLAN',
          description: plan.name,
          quantity: subscription.quantity,
          amountMinor: lineAmount(
            price.unitAmountMinor,
            price.perSeat,
            subscription.quantity,
          ),
        },
        ...(usageLines ?? []).map((line) => ({
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          amountMinor: line.amountMinor,
        })),
      ];
      const subtotal = lines.reduce((sum, l) => sum + l.amountMinor, 0);
      const credit = Math.max(
        0,
        Math.min(subscription.creditBalanceMinor, subtotal),
      );
      if (credit > 0)
        lines.push({
          kind: 'CREDIT',
          description: 'Credit balance applied',
          quantity: 1,
          amountMinor: -credit,
        });

      const trial = subscription.status === 'TRIALING';
      const patch = {
        currentPeriodStart: start,
        currentPeriodEnd: end,
        ...(trial && { trialEndsAt: null }),
        ...(credit > 0 && { creditDeltaMinor: -credit }),
      };
      const step = {
        reason: trial ? 'trial_ended' : 'renewed',
        actor,
        at: now,
      };
      const updated = trial
        ? await this.transitions.move(view, 'trial_ended', step, patch)
        : await this.transitions.keep(view, patch, step);
      if (!updated) return 'skipped';

      const { created } = await this.issuer.issue({
        subscriptionId: subscription.id,
        kind: 'RENEWAL',
        businessKey: `renewal:${start.toISOString()}`,
        periodStart: start,
        periodEnd: end,
        currency: price.currency,
        lines,
        usageMeasuredAt: subscription.subjectType === 'SHOP' ? now : null,
        now,
      });
      // A second invoice for this period must never exist: undo the whole renewal rather than half of it.
      if (!created)
        throw new Error('the renewal invoice of this period already exists');
      return 'invoiced';
    });
    // Counted after the commit: a rolled-back renewal is not a renewal.
    if (outcome !== 'deferred')
      renewalsCounter.add(1, {
        outcome: outcome === 'skipped' ? 'already_renewed' : outcome,
      });
    return outcome;
  }
}
