import { Injectable } from '@nestjs/common';
import type {
  CancelRequest,
  ChangeRequest,
  ChangeResult,
  InvoiceDto,
  InvoicePage,
  SubscribeRequest,
  SubscriptionRead,
} from '@marketplace-sandbox/contracts';
import { CancellationService } from '../application/cancellation.service';
import { ChangeService } from '../application/change.service';
import { EntitlementsService } from '../application/entitlements.service';
import { InvoiceQueryService } from '../application/invoice-query.service';
import { PaymentMethodService } from '../application/payment-method.service';
import { SubscribeService } from '../application/subscribe.service';
import { SubscriptionQueryService } from '../application/subscription-query.service';
import type { Subject } from '../domain/types';
import {
  toChangeResult,
  toInvoice,
  toInvoiceSummary,
  toPreview,
  toSubscription,
} from './billing.mappers';

/**
 * What the shop and buyer controllers share (S17 contracts/http.md: "same shapes"): one service call per route and
 * the mapping to contract DTOs. The two controllers differ only in how they find the subject.
 */
@Injectable()
export class BillingApi {
  constructor(
    private readonly subscribeService: SubscribeService,
    private readonly changes: ChangeService,
    private readonly cancellations: CancellationService,
    private readonly paymentMethods: PaymentMethodService,
    private readonly queries: SubscriptionQueryService,
    private readonly invoiceQueries: InvoiceQueryService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async read(subject: Subject): Promise<SubscriptionRead> {
    const detail = await this.queries.forSubject(subject);
    return {
      subscription: detail ? toSubscription(detail) : null,
      entitlements: (await this.entitlements.get(
        subject.subjectType,
        subject.subjectId,
      )) as SubscriptionRead['entitlements'],
    };
  }

  async subscribe(subject: Subject, userId: string, body: SubscribeRequest) {
    return toSubscription(
      await this.subscribeService.subscribe(subject, body, userId),
    );
  }

  async preview(subject: Subject, body: ChangeRequest) {
    return toPreview(await this.changes.preview(subject, body));
  }

  async change(
    subject: Subject,
    userId: string,
    body: ChangeRequest,
  ): Promise<ChangeResult> {
    const { lines, detail } = await this.changes.change(subject, body, userId);
    return toChangeResult(lines, detail);
  }

  async cancel(subject: Subject, userId: string, body: CancelRequest) {
    return toSubscription(
      await this.cancellations.cancel(subject, body, userId),
    );
  }

  async resume(subject: Subject, userId: string) {
    return toSubscription(await this.cancellations.resume(subject, userId));
  }

  async updatePaymentMethod(subject: Subject, paymentMethodRef: string) {
    return toSubscription(
      await this.paymentMethods.update(subject, paymentMethodRef),
    );
  }

  async invoices(
    subject: Subject,
    query: { limit: number; cursor?: string },
  ): Promise<InvoicePage> {
    const page = await this.invoiceQueries.list(
      subject,
      query.limit,
      query.cursor,
    );
    return {
      items: page.items.map(toInvoiceSummary),
      nextCursor: page.nextCursor,
    };
  }

  async invoice(subject: Subject, invoiceId: string): Promise<InvoiceDto> {
    const { invoice, lines } = await this.invoiceQueries.detail(
      subject,
      invoiceId,
    );
    return toInvoice(invoice, lines);
  }
}
