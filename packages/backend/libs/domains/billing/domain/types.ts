import type { InvoiceStatus } from './invoice-status';
import type { BillingInterval } from './periods';
import type { SubscriptionStatus } from './subscription-status';

export type SubjectType = 'USER' | 'SHOP';
export interface Subject {
  subjectType: SubjectType;
  subjectId: string;
}
export type Audience = 'BUYER' | 'SHOP';
export type PlanTier = 'STARTER' | 'PRO' | 'ENTERPRISE';
export type InvoiceKind = 'RENEWAL' | 'PRORATION';
export type EntitlementValues = Record<string, boolean | number>;

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  audience: Audience;
  entitlements: EntitlementValues;
  createdAt: Date;
}

export interface PriceRow {
  id: string;
  planId: string;
  version: number;
  interval: BillingInterval;
  unitAmountMinor: number;
  currency: string;
  perSeat: boolean;
  trialDays: number;
  includedUsage: Record<string, number>;
  overagePer1000Minor: Record<string, number>;
  active: boolean;
  createdAt: Date;
}

export interface PriceWithPlan extends PriceRow {
  plan: { code: string; name: string; audience: Audience };
}

/** A subscription as the application sees it. The payment-method reference is NOT here: only `hasPaymentMethod`. */
export interface SubscriptionRow extends Subject {
  id: string;
  priceId: string;
  status: SubscriptionStatus;
  quantity: number;
  billingAnchorDay: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string | null;
  canceledAt: Date | null;
  offboardingStartedAt: Date | null;
  statusSince: Date;
  hasPaymentMethod: boolean;
  creditBalanceMinor: number;
  version: number;
  createdAt: Date;
}

export interface SubscriptionView {
  subscription: SubscriptionRow;
  price: PriceRow;
  plan: { code: string; name: string; audience: Audience };
}

export interface InvoiceRow {
  id: string;
  subscriptionId: string;
  kind: InvoiceKind;
  businessKey: string;
  periodStart: Date;
  periodEnd: Date;
  status: InvoiceStatus;
  totalMinor: number;
  currency: string;
  attempts: number;
  attemptStartedAt: Date | null;
  /** The attempt in flight: `1`..`4` or `manual:<k>`; null while none is claimed. */
  attemptRef: string | null;
  attemptUnknown: boolean;
  manualAttempts: number;
  firstFailedAt: Date | null;
  nextAttemptAt: Date | null;
  usageMeasuredAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface SubscriptionDetail {
  view: SubscriptionView;
  latestInvoice: { invoice: InvoiceRow; lines: InvoiceLineRow[] } | null;
}

export type InvoiceLineKind =
  | 'PLAN'
  | 'USAGE'
  | 'ADJUSTMENT'
  | 'CREDIT'
  | 'PRORATION_CREDIT'
  | 'PRORATION_CHARGE'
  | 'PRORATION';

export interface InvoiceLineRow {
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  amountMinor: number;
}

/** Who caused a history row (the store checks the shape: `user:<uuid>`, `system:billing-run`, `system:dunning`, `event:<uuid>`). */
export type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'system'; name: 'billing-run' | 'dunning' }
  | { kind: 'event'; id: string };

export const actorText = (actor: Actor): string =>
  actor.kind === 'system'
    ? `system:${actor.name}`
    : `${actor.kind}:${actor.id}`;

export interface HistoryEntry {
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
  reason: string;
  actor: Actor;
  at: Date;
}
