import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  alreadySubscribed,
  paymentMethodRequired,
  planNotAvailableForSubject,
  priceNotFound,
  quantityNotApplicable,
  sandboxShopNotBillable,
  trialNotAvailable,
} from '../domain/errors';
import { lineAmount } from '../domain/money';
import { DAY_MS, addPeriod } from '../domain/periods';
import {
  CATALOG_REPOSITORY,
  SHOP_DIRECTORY,
  SUBSCRIPTION_REPOSITORY,
  type CatalogRepository,
  type ShopDirectory,
  type SubscriptionRepository,
} from '../domain/ports';
import type {
  InvoiceLineRow,
  Subject,
  SubscriptionDetail,
} from '../domain/types';
import { InvoiceIssuer } from './invoice-issuer.service';
import { SubscriptionTransitions } from './subscription-transitions.service';

export interface SubscribeInput {
  priceId: string;
  quantity?: number;
  paymentMethodRef?: string;
}

/**
 * Subscribing (S17 FR-007 to FR-012). Eligibility is decided before anything is written (the shop fact is read
 * before the transaction); then ONE transaction writes the subscription, its history row, the first invoice with its
 * lines, the request to charge it and the outbox events. The provider is never called here: the charge job runs after
 * commit. A trial's length is the price's, available once per subject, and needs a payment method.
 */
@Injectable()
export class SubscribeService {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly issuer: InvoiceIssuer,
    private readonly transitions: SubscriptionTransitions,
  ) {}

  async subscribe(
    subject: Subject,
    input: SubscribeInput,
    actorUserId: string,
  ): Promise<SubscriptionDetail> {
    const price = await this.catalog.findPrice(input.priceId);
    if (!price?.active) throw priceNotFound();
    if (
      price.plan.audience !==
      (subject.subjectType === 'SHOP' ? 'SHOP' : 'BUYER')
    )
      throw planNotAvailableForSubject();
    if (subject.subjectType === 'SHOP') {
      const facts = await this.shops.facts(subject.subjectId);
      if (facts?.isSandbox) throw sandboxShopNotBillable();
    }
    if (await this.subscriptions.findLive(subject)) throw alreadySubscribed();

    const quantity = input.quantity ?? 1;
    if (!price.perSeat && quantity !== 1) throw quantityNotApplicable();
    const trial = price.trialDays > 0;
    const amount = lineAmount(price.unitAmountMinor, price.perSeat, quantity);
    if (trial && (await this.subscriptions.hasEverSubscribed(subject)))
      throw trialNotAvailable();
    if ((trial || amount > 0) && !input.paymentMethodRef)
      throw paymentMethodRequired();

    const now = this.clock.now();
    const trialEndsAt = trial
      ? new Date(now.getTime() + price.trialDays * DAY_MS)
      : null;
    const anchorDay = (trialEndsAt ?? now).getUTCDate();
    const periodEnd = trialEndsAt ?? addPeriod(now, price.interval, anchorDay);
    const status = trial ? 'TRIALING' : 'ACTIVE';

    return this.tx.run(async () => {
      const created = await this.subscriptions.insert(
        {
          ...subject,
          priceId: price.id,
          status,
          quantity,
          billingAnchorDay: anchorDay,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          trialEndsAt,
          paymentMethodRef: input.paymentMethodRef ?? null,
          now,
        },
        {
          from: null,
          to: status,
          reason: 'subscribed',
          actor: { kind: 'user', id: actorUserId },
          at: now,
        },
      );
      if (!created) throw alreadySubscribed();

      let latestInvoice: SubscriptionDetail['latestInvoice'] = null;
      if (!trial) {
        const lines: InvoiceLineRow[] = [
          {
            kind: 'PLAN',
            description: price.plan.name,
            quantity,
            amountMinor: amount,
          },
        ];
        const { invoice } = await this.issuer.issue({
          subscriptionId: created.subscription.id,
          kind: 'RENEWAL',
          businessKey: `renewal:${now.toISOString()}`,
          periodStart: now,
          periodEnd,
          currency: price.currency,
          lines,
          now,
        });
        latestInvoice = { invoice, lines };
      }
      await this.transitions.announceNew(created, now);
      return { view: created, latestInvoice };
    });
  }
}
