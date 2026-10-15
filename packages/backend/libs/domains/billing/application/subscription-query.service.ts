import { Inject, Injectable } from '@nestjs/common';
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

/** Reads of the live subscription of a subject with its latest invoice (S17 FR-050): the subject is in the predicate. */
@Injectable()
export class SubscriptionQueryService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
  ) {}

  async detailOf(view: SubscriptionView): Promise<SubscriptionDetail> {
    const invoice = await this.invoices.latestFor(view.subscription.id);
    return {
      view,
      latestInvoice: invoice
        ? { invoice, lines: await this.invoices.lines(invoice.id) }
        : null,
    };
  }

  async forSubject(subject: Subject): Promise<SubscriptionDetail | null> {
    const view = await this.subscriptions.findLive(subject);
    return view ? this.detailOf(view) : null;
  }
}
