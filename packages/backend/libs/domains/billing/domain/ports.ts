import type { ChargeOutcome, LookupOutcome } from './charge-outcome';
import type { InvoiceCursor } from './cursor';
import type { InvoiceStatus } from './invoice-status';
import type { BillingInterval } from './periods';
import type { SubscriptionStatus } from './subscription-status';
import type {
  Audience,
  EntitlementValues,
  HistoryEntry,
  InvoiceKind,
  InvoiceLineRow,
  InvoiceRow,
  PlanRow,
  PlanTier,
  PriceRow,
  PriceWithPlan,
  Subject,
  SubscriptionView,
} from './types';

/**
 * Ports of the billing domain (constitution I.2): the application depends on these shapes, `infra/` binds them to
 * Sequelize SQL, the provider SDK and other domains' exported services. Every method joins the caller's transaction
 * (CLS) when there is one. The payment-method reference never appears in a row type: only `paymentMethodRefOf`
 * returns it, and only the charge path calls that.
 */

// ---- Catalog ---------------------------------------------------------------------------------------------------------
export interface CatalogRepository {
  /** Plans with their ACTIVE prices only, ordered by plan code, interval, amount, id. */
  listActive(): Promise<Array<{ plan: PlanRow; prices: PriceRow[] }>>;
  findPlan(planId: string): Promise<PlanRow | null>;
  /** `null` when the code is taken. */
  insertPlan(input: {
    code: string;
    name: string;
    audience: Audience;
    entitlements: EntitlementValues;
  }): Promise<PlanRow | null>;
  /** Publishes the next version for `(plan, interval)`; never touches an existing price. */
  insertPrice(
    planId: string,
    input: {
      interval: BillingInterval;
      unitAmountMinor: number;
      currency: string;
      perSeat: boolean;
      trialDays: number;
      includedUsage: Record<string, number>;
      overagePer1000Minor: Record<string, number>;
    },
  ): Promise<PriceRow>;
  findPrice(priceId: string): Promise<PriceWithPlan | null>;
  retirePrice(
    priceId: string,
  ): Promise<'retired' | 'already_retired' | 'missing'>;
}

// ---- Subscriptions ---------------------------------------------------------------------------------------------------
export interface NewSubscription extends Subject {
  priceId: string;
  status: SubscriptionStatus;
  quantity: number;
  billingAnchorDay: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  paymentMethodRef: string | null;
  now: Date;
}

/** Changes applied by one version-guarded update; fields left out are unchanged. */
export interface SubscriptionPatch {
  priceId?: string;
  quantity?: number;
  status?: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
  cancelReason?: string | null;
  canceledAt?: Date | null;
  offboardingStartedAt?: Date | null;
  paymentMethodRef?: string | null;
  /** Added to the credit balance (negative to use it); the store keeps the balance non-negative. */
  creditDeltaMinor?: number;
}

export interface LiveBasisRow {
  subjectId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  planCode: string;
  entitlements: EntitlementValues;
  subscriptionVersion: number;
}

export interface SubscriptionRepository {
  /** The live (not `CANCELED`) subscription of a subject with its price and plan. */
  findLive(subject: Subject): Promise<SubscriptionView | null>;
  findById(id: string): Promise<SubscriptionView | null>;
  /**
   * The subscription row locked for the rest of the transaction. Waits for a concurrent writer (a change, another
   * run) so the caller always re-checks fresh state; `null` only when the row is gone.
   */
  lockForRenewal(id: string): Promise<SubscriptionView | null>;
  hasEverSubscribed(subject: Subject): Promise<boolean>;
  /** `null` when the subject already has a live subscription (the store's unique index decided). */
  insert(
    input: NewSubscription,
    history: HistoryEntry,
  ): Promise<SubscriptionView | null>;
  /**
   * Applies `patch` only if the row still has `expectVersion` (and `expectStatus` when given), bumps the version and
   * writes one history row with the new version. `null` when the guard failed: someone else moved first.
   */
  applyUpdate(
    id: string,
    expect: { version: number; status?: SubscriptionStatus },
    patch: SubscriptionPatch,
    history: HistoryEntry,
  ): Promise<SubscriptionView | null>;
  /** Stores a new reference on the live subscription of a subject; `null` when there is none. */
  setPaymentMethodRef(
    subject: Subject,
    ref: string,
    now: Date,
  ): Promise<SubscriptionView | null>;
  paymentMethodRefOf(subscriptionId: string): Promise<string | null>;
  /** Erases the stored reference of every subscription of a subject (a deleted shop). Returns how many held one. */
  eraseCredentials(subject: Subject, now: Date): Promise<number>;
  /** Committed state of the live-for-entitlements subscriptions (`TRIALING`, `ACTIVE`, `PAST_DUE`) of up to 500 subjects. */
  liveBasis(
    subjectType: Subject['subjectType'],
    subjectIds: string[],
  ): Promise<LiveBasisRow[]>;
  /** Ids of subscriptions the run must look at: due renewals, scheduled cancellations, 30-day `UNPAID`. */
  listDueIds(now: Date, unpaidCutoff: Date, limit: number): Promise<string[]>;
  countOverdue(overdueBefore: Date): Promise<number>;
}

// ---- Invoices --------------------------------------------------------------------------------------------------------
export interface NewInvoice {
  subscriptionId: string;
  kind: InvoiceKind;
  businessKey: string;
  periodStart: Date;
  periodEnd: Date;
  status: Extract<InvoiceStatus, 'OPEN' | 'PAID'>;
  totalMinor: number;
  currency: string;
  usageMeasuredAt: Date | null;
  now: Date;
}

export type AttemptKind = { type: 'numbered' } | { type: 'manual'; k: number };

export interface InvoicePage {
  items: InvoiceRow[];
  /** Keyset position of the last item when more rows exist. */
  next: InvoiceCursor | null;
}

export interface InvoiceRepository {
  /** Inserts the invoice and its lines, or returns the existing invoice of the same business key. */
  insertWithLines(
    invoice: NewInvoice,
    lines: InvoiceLineRow[],
  ): Promise<{ invoice: InvoiceRow; created: boolean }>;
  findById(id: string): Promise<InvoiceRow | null>;
  lines(invoiceId: string): Promise<InvoiceLineRow[]>;
  latestFor(subscriptionId: string): Promise<InvoiceRow | null>;
  /** The oldest invoice still to be collected (`OPEN` or `UNCOLLECTIBLE`, total > 0). */
  oldestOwed(subscriptionId: string): Promise<InvoiceRow | null>;
  countOwed(subscriptionId: string): Promise<number>;
  /** The last `RENEWAL` before `before`, for late-usage pricing. */
  previousRenewal(
    subscriptionId: string,
    before: Date,
  ): Promise<InvoiceRow | null>;
  /**
   * Starts an attempt: one conditional update that fires only for an invoice that is owed, has no attempt in flight,
   * is due and (numbered) has numbered attempts left. `null` when nothing was claimed.
   */
  claimAttempt(
    id: string,
    kind: AttemptKind,
    now: Date,
  ): Promise<InvoiceRow | null>;
  /** The attempt `attemptRef` ends paid: guarded by "that attempt is in flight". `null` when it was already settled. */
  settlePaid(
    id: string,
    attemptRef: string,
    now: Date,
  ): Promise<InvoiceRow | null>;
  /** The attempt ends in a definite failure. `uncollectible` closes the invoice after the last numbered attempt. */
  settleFailed(
    id: string,
    input: {
      attemptRef: string;
      now: Date;
      firstFailedAt: Date;
      nextAttemptAt: Date | null;
      uncollectible: boolean;
    },
  ): Promise<InvoiceRow | null>;
  /** The attempt's outcome is not known: it stays claimed and is flagged. `false` when it was already settled. */
  markUnknown(id: string, attemptRef: string, now: Date): Promise<boolean>;
  /** Cancelling now: every `OPEN` invoice becomes `UNCOLLECTIBLE` (history row each). Returns how many. */
  writeOffOpen(
    subscriptionId: string,
    now: Date,
    reason: string,
  ): Promise<number>;
  list(
    subject: Subject,
    limit: number,
    after: InvoiceCursor | null,
  ): Promise<InvoicePage>;
  /** The invoice only if it belongs to the subject (the subject is in the predicate). */
  findForSubject(
    subject: Subject,
    invoiceId: string,
  ): Promise<InvoiceRow | null>;
  countUnknownAttempts(): Promise<number>;
}

// ---- Plan tier counter -----------------------------------------------------------------------------------------------
export interface PlanStateRepository {
  /**
   * Records `tier` as the shop's announced tier; returns the new per-shop version, or `null` when the tier is
   * unchanged. The first write for a shop always counts as a change.
   */
  bump(subject: Subject, tier: PlanTier, now: Date): Promise<number | null>;
}

// ---- Edges -----------------------------------------------------------------------------------------------------------
export interface ChargeRequest {
  invoiceId: string;
  subscriptionId: string;
  /** `1`..`4` or `manual:<k>`. */
  attemptRef: string;
  amountMinor: number;
  currency: string;
  paymentMethodRef: string;
  timeoutMs: number;
}

export interface BillingGateway {
  /** Never throws for a provider answer: everything is classified. Never retried by the caller for the same ref. */
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
  /** Looks the charge up by our reference. Throws when the provider cannot be reached (the attempt stays unknown). */
  lookup(
    invoiceId: string,
    attemptRef: string,
    timeoutMs: number,
  ): Promise<LookupOutcome>;
}

export interface ShopFacts {
  isSandbox: boolean;
}

/** Anti-corruption port over tenancy's R1 batch read: the one fact billing needs from a shop. */
export interface ShopDirectory {
  facts(shopId: string): Promise<ShopFacts | null>;
}

export interface UsageLine {
  kind: 'USAGE' | 'ADJUSTMENT';
  description: string;
  quantity: number;
  amountMinor: number;
}

/** S18's contract: the usage lines of a renewal. Read-only, bounded, throws on failure. */
export interface UsageInvoiceLinesProvider {
  linesFor(input: {
    subscriptionId: string;
    subjectId: string;
    priceId: string;
    periodStart: Date;
    periodEnd: Date;
    measuredAt: Date;
    timeoutMs: number;
  }): Promise<{ lines: UsageLine[] }>;
}

/** Cooperative stop for long work (S54 shutdown registry): checked between units of work. */
export interface StopSignal {
  isStopping(): boolean;
}

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');
export const SUBSCRIPTION_REPOSITORY = Symbol('SUBSCRIPTION_REPOSITORY');
export const INVOICE_REPOSITORY = Symbol('INVOICE_REPOSITORY');
export const PLAN_STATE_REPOSITORY = Symbol('PLAN_STATE_REPOSITORY');
export const BILLING_GATEWAY = Symbol('BILLING_GATEWAY');
export const SHOP_DIRECTORY = Symbol('SHOP_DIRECTORY');
export const USAGE_LINES_PROVIDER = Symbol('USAGE_LINES_PROVIDER');
export const STOP_SIGNAL = Symbol('STOP_SIGNAL');
