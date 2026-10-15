import type {
  AdminPrice,
  CatalogPrice,
  ChangePreview,
  InvoiceDto,
  InvoiceLineDto,
  InvoiceSummary,
  PlanCatalog,
  PlanDto,
  SubscriptionDto,
} from '@marketplace-sandbox/contracts';
import type { ChangePreview as ChangePreviewResult } from '../application/change.service';
import type {
  InvoiceLineRow,
  InvoiceRow,
  PlanRow,
  PriceRow,
  SubscriptionDetail,
} from '../domain/types';

/**
 * Model-free DTO mappers (S17 FR-013, A1): the API returns what these build and nothing else. The payment-method
 * reference is not in any row type, so it cannot leak; `hasPaymentMethod` is all a client learns about it.
 */
const iso = (date: Date): string => date.toISOString();

const toLine = (line: InvoiceLineRow): InvoiceLineDto => ({
  kind: line.kind,
  description: line.description,
  quantity: line.quantity,
  amountMinor: line.amountMinor,
});

export const toCatalogPrice = (price: PriceRow): CatalogPrice => ({
  id: price.id,
  version: price.version,
  interval: price.interval,
  unitAmountMinor: price.unitAmountMinor,
  currency: price.currency as 'EUR',
  perSeat: price.perSeat,
  trialDays: price.trialDays,
  includedUsage: price.includedUsage,
  overagePer1000Minor: price.overagePer1000Minor,
});

export const toCatalog = (
  entries: Array<{ plan: PlanRow; prices: PriceRow[] }>,
): PlanCatalog => ({
  plans: entries.map(({ plan, prices }) => ({
    code: plan.code,
    name: plan.name,
    audience: plan.audience,
    entitlements: plan.entitlements,
    prices: prices.map(toCatalogPrice),
  })),
});

export const toPlan = (plan: PlanRow): PlanDto => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  audience: plan.audience,
  entitlements: plan.entitlements,
  createdAt: iso(plan.createdAt),
});

export const toAdminPrice = (price: PriceRow): AdminPrice => ({
  ...toCatalogPrice(price),
  planId: price.planId,
  active: price.active,
  createdAt: iso(price.createdAt),
});

export const toSubscription = (detail: SubscriptionDetail): SubscriptionDto => {
  const { subscription, price, plan } = detail.view;
  return {
    id: subscription.id,
    status: subscription.status,
    plan: { code: plan.code, name: plan.name },
    priceId: price.id,
    interval: price.interval,
    unitAmountMinor: price.unitAmountMinor,
    currency: price.currency,
    perSeat: price.perSeat,
    quantity: subscription.quantity,
    currentPeriodStart: iso(subscription.currentPeriodStart),
    currentPeriodEnd: iso(subscription.currentPeriodEnd),
    trialEndsAt: subscription.trialEndsAt
      ? iso(subscription.trialEndsAt)
      : null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    hasPaymentMethod: subscription.hasPaymentMethod,
    creditBalanceMinor: subscription.creditBalanceMinor,
    version: subscription.version,
    latestInvoice: detail.latestInvoice
      ? {
          id: detail.latestInvoice.invoice.id,
          kind: detail.latestInvoice.invoice.kind,
          status: detail.latestInvoice.invoice.status,
          totalMinor: detail.latestInvoice.invoice.totalMinor,
          lines: detail.latestInvoice.lines.map(toLine),
        }
      : null,
  };
};

export const toInvoiceSummary = (invoice: InvoiceRow): InvoiceSummary => ({
  id: invoice.id,
  subscriptionId: invoice.subscriptionId,
  kind: invoice.kind,
  status: invoice.status,
  totalMinor: invoice.totalMinor,
  currency: invoice.currency,
  periodStart: iso(invoice.periodStart),
  periodEnd: iso(invoice.periodEnd),
  createdAt: iso(invoice.createdAt),
  paidAt: invoice.paidAt ? iso(invoice.paidAt) : null,
});

export const toInvoice = (
  invoice: InvoiceRow,
  lines: InvoiceLineRow[],
): InvoiceDto => ({
  ...toInvoiceSummary(invoice),
  attempts: invoice.attempts,
  nextAttemptAt: invoice.nextAttemptAt ? iso(invoice.nextAttemptAt) : null,
  lines: lines.map(toLine),
});

export const toPreview = (preview: ChangePreviewResult): ChangePreview => ({
  lines: preview.lines.map((line) => ({
    kind: line.kind,
    description: line.description,
    amountMinor: line.amount,
  })),
  dueNowMinor: preview.dueNowMinor,
  creditAppliedMinor: preview.creditAppliedMinor,
  effectiveAt: iso(preview.effectiveAt),
});

export const toChangeResult = (
  lines: InvoiceLineRow[],
  detail: SubscriptionDetail,
) => ({ lines: lines.map(toLine), subscription: toSubscription(detail) });
