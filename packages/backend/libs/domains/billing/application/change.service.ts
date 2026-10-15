import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  billingIntervalChangeNotSupported,
  noActiveSubscription,
  noChangeRequested,
  planNotAvailableForSubject,
  priceNotFound,
  quantityNotApplicable,
  subscriptionChangedConcurrently,
  subscriptionNotChangeable,
} from '../domain/errors';
import { lineAmount } from '../domain/money';
import {
  CATALOG_REPOSITORY,
  SUBSCRIPTION_REPOSITORY,
  type CatalogRepository,
  type SubscriptionRepository,
} from '../domain/ports';
import { prorate, type ProrationLine } from '../domain/proration';
import { isChangeable } from '../domain/subscription-status';
import type {
  InvoiceLineRow,
  PriceRow,
  Subject,
  SubscriptionDetail,
  SubscriptionView,
} from '../domain/types';
import { InvoiceIssuer } from './invoice-issuer.service';
import { SubscriptionQueryService } from './subscription-query.service';
import { SubscriptionTransitions } from './subscription-transitions.service';

export interface ChangeInput {
  priceId?: string;
  quantity?: number;
}

export interface ChangePreview {
  lines: ProrationLine[];
  dueNowMinor: number;
  creditAppliedMinor: number;
  effectiveAt: Date;
}

interface ChangePlan {
  view: SubscriptionView;
  newPrice: PriceRow;
  quantity: number;
  priceChanged: boolean;
  trialing: boolean;
  lines: ProrationLine[];
  net: number;
  at: Date;
}

/**
 * Plan and seat changes (S17 FR-040 to FR-046). Preview and change run the same function at the same clock reading,
 * so the invoice equals the preview to the minor unit; preview writes nothing. A change is a version-guarded update:
 * of two concurrent changes exactly one wins and the other answers `409`. A net charge becomes a charged
 * `PRORATION` invoice keyed by the new version; a net credit becomes a closed invoice and a credit balance applied to
 * later renewals. A change while trialing swaps the price with no invoice.
 */
@Injectable()
export class ChangeService {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly issuer: InvoiceIssuer,
    private readonly transitions: SubscriptionTransitions,
    private readonly queries: SubscriptionQueryService,
  ) {}

  async preview(subject: Subject, input: ChangeInput): Promise<ChangePreview> {
    const view = await this.subscriptions.findLive(subject);
    const plan = await this.plan(view, input);
    return {
      lines: plan.lines,
      dueNowMinor: Math.max(plan.net, 0),
      creditAppliedMinor: 0,
      effectiveAt: plan.at,
    };
  }

  async change(
    subject: Subject,
    input: ChangeInput,
    actorUserId: string,
  ): Promise<{ lines: InvoiceLineRow[]; detail: SubscriptionDetail }> {
    const done = await this.tx.run(async () => {
      // Read inside the transaction; the version guard of the update is what makes the change safe.
      const plan = await this.plan(
        await this.subscriptions.findLive(subject),
        input,
      );
      const { view, at } = plan;
      const credit = plan.net < 0 ? -plan.net : 0;
      const updated = await this.transitions.keep(
        view,
        {
          priceId: plan.newPrice.id,
          quantity: plan.quantity,
          ...(credit > 0 && { creditDeltaMinor: credit }),
        },
        {
          reason: plan.priceChanged ? 'plan_changed' : 'quantity_changed',
          actor: { kind: 'user', id: actorUserId },
          at,
        },
      );
      if (!updated) throw subscriptionChangedConcurrently();

      const lines: InvoiceLineRow[] = plan.lines.map((line) => ({
        kind: line.kind,
        description: line.description,
        quantity: 1,
        amountMinor: line.amount,
      }));
      if (!plan.trialing && lines.length > 0)
        await this.issuer.issue({
          subscriptionId: view.subscription.id,
          kind: 'PRORATION',
          businessKey: `proration:v${updated.subscription.version}`,
          periodStart: at,
          periodEnd: view.subscription.currentPeriodEnd,
          currency: updated.price.currency,
          lines,
          now: at,
        });
      return { lines, updated };
    });
    return {
      lines: done.lines,
      detail: await this.queries.detailOf(done.updated),
    };
  }

  private async plan(
    view: SubscriptionView | null,
    input: ChangeInput,
  ): Promise<ChangePlan> {
    if (!view) throw noActiveSubscription();
    const { subscription, price: current } = view;
    if (!isChangeable(subscription.status)) throw subscriptionNotChangeable();

    const priceChanged =
      input.priceId !== undefined && input.priceId !== current.id;
    let newPrice: PriceRow = current;
    if (priceChanged) {
      const found = await this.catalog.findPrice(input.priceId as string);
      if (!found?.active) throw priceNotFound();
      if (found.plan.audience !== view.plan.audience)
        throw planNotAvailableForSubject();
      if (found.interval !== current.interval)
        throw billingIntervalChangeNotSupported();
      newPrice = found;
    }
    const quantity =
      input.quantity ?? (newPrice.perSeat ? subscription.quantity : 1);
    if (!newPrice.perSeat && quantity !== 1) throw quantityNotApplicable();
    if (!priceChanged && quantity === subscription.quantity)
      throw noChangeRequested();

    const at = this.clock.now();
    const trialing = subscription.status === 'TRIALING';
    const proration = trialing
      ? { lines: [], net: 0 }
      : prorate({
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          changeAt: at,
          oldAmount: lineAmount(
            current.unitAmountMinor,
            current.perSeat,
            subscription.quantity,
          ),
          newAmount: lineAmount(
            newPrice.unitAmountMinor,
            newPrice.perSeat,
            quantity,
          ),
        });
    return {
      view,
      newPrice,
      quantity,
      priceChanged,
      trialing,
      lines: proration.lines,
      net: proration.net,
      at,
    };
  }
}
