import type { Transaction } from 'sequelize';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type { PayoutStatus } from './payout-state';

/**
 * Ports of the payouts (S15 contracts/services.md "Consumed R1"): `application/` reaches the stores, the ledger,
 * tenancy, the job queue, the outbox and the payment provider only through these tokens; the adapters live in
 * `infra/`. Money is integer minor units; times are `Date`.
 */

export const PAYOUT_REPOSITORY = Symbol('PAYOUT_REPOSITORY');
export const PAYOUT_RUN_REPOSITORY = Symbol('PAYOUT_RUN_REPOSITORY');
export const PAYOUT_DESTINATION_REPOSITORY = Symbol(
  'PAYOUT_DESTINATION_REPOSITORY',
);
export const PAYOUT_RESERVE_REPOSITORY = Symbol('PAYOUT_RESERVE_REPOSITORY');
export const PAYOUT_AUDIT_REPOSITORY = Symbol('PAYOUT_AUDIT_REPOSITORY');
export const SHOP_SUMMARY_PORT = Symbol('SHOP_SUMMARY_PORT');
export const PAYOUT_LEDGER = Symbol('PAYOUT_LEDGER');
export const PAYOUT_PROVIDER = Symbol('PAYOUT_PROVIDER');
export const PAYOUT_JOBS = Symbol('PAYOUT_JOBS');
export const PAYOUT_EVENTS = Symbol('PAYOUT_EVENTS');

// ---- the aggregate

export interface PayoutRecord {
  id: string;
  shopId: string;
  periodStart: string;
  currency: string;
  amountMinor: number;
  reserveHeldMinor: number;
  status: PayoutStatus;
  destinationSnapshot: string | null;
  transferRef: string | null;
  failureCode: string | null;
  failureReason: string | null;
  attempts: number;
  resendCount: number;
  lookupFailures: number;
  nextResolveAt: Date | null;
  inDoubtSince: Date | null;
  inDoubtEventAt: Date | null;
  discrepancyReportedAt: Date | null;
  payoutVersion: number;
  submittedAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  /** `createdAt` with its microseconds, as text: the operator list's keyset position. */
  createdAtKey: string;
}

export interface NewPayout {
  shopId: string;
  periodStart: string;
  currency: string;
  amountMinor: number;
  reserveHeldMinor: number;
  destinationSnapshot: string;
}

/** Columns a transition may set together with the status. `undefined` leaves a column alone. */
export interface PayoutPatch {
  transferRef?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  attempts?: number;
  resendCount?: number;
  lookupFailures?: number;
  nextResolveAt?: Date | null;
  inDoubtSince?: Date | null;
  submittedAt?: Date | null;
  paidAt?: Date | null;
  cancelledAt?: Date | null;
}

export interface HistoryRow {
  payoutId: string;
  fromStatus: PayoutStatus | null;
  toStatus: PayoutStatus;
  payoutVersion: number;
  actor: string;
  reason: string | null;
  at: Date;
}

export interface AdminListFilter {
  status?: PayoutStatus;
  shopId?: string;
  periodStart?: string;
}

export interface PayoutRepository {
  /** `INSERT … ON CONFLICT (shopId, periodStart) DO NOTHING`: the new id, or `null` when the week already has one. */
  insertIfAbsent(
    payout: NewPayout,
    now: Date,
    tx: Transaction,
  ): Promise<string | null>;
  findById(id: string, tx?: Transaction): Promise<PayoutRecord | null>;
  /** The principal is in the predicate: another shop's payout is not found (III.4). */
  findForShop(id: string, shopId: string): Promise<PayoutRecord | null>;
  /**
   * `UPDATE … SET status = :to, payoutVersion = payoutVersion + 1 … WHERE id AND status IN :from`: the updated row, or
   * `null` when the payout was not in one of the `from` statuses (another path won).
   */
  transition(
    id: string,
    from: readonly PayoutStatus[],
    to: PayoutStatus,
    patch: PayoutPatch,
    now: Date,
    tx: Transaction,
  ): Promise<PayoutRecord | null>;
  /** Attempt fence: `SENDING` payout whose `attempts < attempt` takes the attempt; false when another delivery has it. */
  takeAttempt(id: string, attempt: number, tx: Transaction): Promise<boolean>;
  /** A flag column set once (`inDoubtEventAt`, `discrepancyReportedAt`): true only for the call that set it. */
  markOnce(
    id: string,
    column: 'inDoubtEventAt' | 'discrepancyReportedAt',
    now: Date,
    tx: Transaction,
  ): Promise<boolean>;
  /** Resolver bookkeeping that changes no status (`lookupFailures`, `nextResolveAt`, `resendCount`). */
  updateWhileInDoubt(
    id: string,
    patch: PayoutPatch,
    now: Date,
    tx?: Transaction,
  ): Promise<void>;
  appendHistory(row: HistoryRow, tx: Transaction): Promise<void>;
  timeline(payoutId: string): Promise<{ toStatus: PayoutStatus; at: Date }[]>;
  /** Newest period first, keyset on `(periodStart, id)`. */
  listForShop(
    shopId: string,
    page: { limit: number; after?: { k: string; id: string } },
  ): Promise<PayoutRecord[]>;
  /** Newest created first, keyset on `(createdAt, id)`. */
  listAll(
    filter: AdminListFilter,
    page: { limit: number; after?: { k: string; id: string } },
  ): Promise<PayoutRecord[]>;
  /** `UNKNOWN`, or `SENDING` since before `staleBefore`, whose `nextResolveAt` is due (or unset). */
  dueForResolution(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<PayoutRecord[]>;
  /** Created at or after a moment, still not final: for the in-doubt gauge. */
  oldestInDoubtSince(): Promise<Date | null>;
  /** `PAID` payouts whose `paidAt` falls in `[from, to)`, keyset on id. */
  paidBetween(
    from: Date,
    to: Date,
    after: string | null,
    limit: number,
  ): Promise<PayoutRecord[]>;
}

// ---- runs, destinations, reserves, audit

export interface PayoutRunRecord {
  periodStart: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  created: number;
  existing: number;
  skipped: Record<string, number>;
  failureCode: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface PayoutRunRepository {
  /** Upserts the run of the period to `RUNNING` with counters reset. */
  start(periodStart: string, now: Date): Promise<void>;
  finish(
    periodStart: string,
    result: {
      status: 'COMPLETED' | 'FAILED';
      created: number;
      existing: number;
      skipped: Record<string, number>;
      failureCode: string | null;
    },
    now: Date,
  ): Promise<void>;
  /** Newest period first. */
  list(page: { limit: number; after?: string }): Promise<PayoutRunRecord[]>;
}

export interface DestinationRecord {
  shopId: string;
  providerAccountId: string;
  effectiveFrom: Date;
  changedAt: Date;
  changedBy: string;
  version: number;
}

export interface PayoutDestinationRepository {
  find(shopId: string, tx?: Transaction): Promise<DestinationRecord | null>;
  findMany(shopIds: string[]): Promise<Map<string, DestinationRecord>>;
  /** Inserts or replaces the destination; `version` becomes 1 for a new one, `+ 1` for a replacement. */
  save(
    record: Omit<DestinationRecord, 'version'>,
    fromMasked: string | null,
    toMasked: string,
    tx: Transaction,
  ): Promise<DestinationRecord>;
}

export interface ReserveRecord {
  shopId: string;
  reserveBps: number;
  reason: string;
  updatedBy: string;
  updatedAt: Date;
}

export interface PayoutReserveRepository {
  find(shopId: string, tx?: Transaction): Promise<ReserveRecord | null>;
  findMany(shopIds: string[]): Promise<Map<string, ReserveRecord>>;
  /** Upsert plus one history row; a no-op write (same bps and reason) returns the stored row untouched. */
  save(record: ReserveRecord, tx: Transaction): Promise<ReserveRecord>;
}

export interface PayoutAuditRepository {
  /** Upserts the marker to `RUNNING`. */
  startDay(day: string, now: Date): Promise<void>;
  finishDay(
    day: string,
    result: {
      status: 'COMPLETED' | 'FAILED';
      checked: number;
      discrepancies: number;
    },
    now: Date,
  ): Promise<void>;
  /** `INSERT … ON CONFLICT DO NOTHING`: true when this call created the finding. */
  insertFinding(
    payoutId: string,
    kind: string,
    day: string,
    now: Date,
    tx: Transaction,
  ): Promise<boolean>;
}

// ---- R1 collaborators

export interface ShopSummary {
  status: string;
  payoutsEnabled: boolean;
}

export interface ShopSummaryPort {
  /** Batches of at most 200 ids; an id missing from the map is unknown to tenancy. */
  getSummaries(shopIds: string[]): Promise<Map<string, ShopSummary>>;
}

/** The ledger refused a payout posting; the caller's transaction is rolled back and the shop skipped. */
export class PayoutLedgerRefusal extends Error {
  constructor(readonly reason: 'insufficient_balance' | 'ledger_busy') {
    super(reason);
    this.name = 'PayoutLedgerRefusal';
  }
}

/** The listing of seller balances failed: the run fails as `ledger_unavailable`. */
export class PayoutLedgerUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super('ledger_unavailable', options);
    this.name = 'PayoutLedgerUnavailable';
  }
}

export interface PayoutLedgerPort {
  /** Seller accounts with at least `minMinor`, by keyset; a failure is `PayoutLedgerUnavailable`. */
  listSellerBalances(input: {
    currency: string;
    minMinor: number;
    limit: number;
    after?: string;
  }): Promise<{
    items: { shopId: string; balanceMinor: number }[];
    next: string | null;
  }>;
  /** Authoritative balances of up to 200 shops; a shop without a row is `0`. Honours the caller's transaction. */
  balances(
    shopIds: string[],
    currency: string,
    tx?: Transaction,
  ): Promise<Map<string, number>>;
  /** `SHOP_x → PAYOUT_CLEARING` (`PAYOUT`, reference `<id>`). May throw `PayoutLedgerRefusal`. */
  postCreated(
    p: { id: string; shopId: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void>;
  /** `PAYOUT_CLEARING → PAYOUTS_SENT` (`PAYOUT`, reference `<id>:sent`). */
  postSent(
    p: { id: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void>;
  /** `PAYOUT_CLEARING → SHOP_x` (`PAYOUT_REVERSAL`, reference `<id>`): a failure or a cancel. */
  postReversal(
    p: { id: string; shopId: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<void>;
}

// ---- the payment provider

export interface TransferRequest {
  /** The payout id: the provider's idempotency key, transfer group and reference. */
  payoutId: string;
  amountMinor: number;
  currency: string;
  destination: string;
}

/**
 * What the provider said, classified by the adapter and nothing else (no retry inside). An `answered` body is still
 * data to be checked by `validateProviderAnswer` before it is believed.
 */
export type TransferOutcome =
  | { kind: 'answered'; answer: unknown }
  | { kind: 'rejected'; code: string }
  | { kind: 'transient'; status: string }
  | { kind: 'unknown' };

export type LookupOutcome =
  | { kind: 'found'; answer: unknown; reversed: boolean }
  | { kind: 'found_rejected'; code: string }
  | { kind: 'not_found' }
  | { kind: 'unreachable' };

export interface PayoutProviderPort {
  transfer(request: TransferRequest): Promise<TransferOutcome>;
  lookupByReference(payoutId: string): Promise<LookupOutcome>;
}

export interface PayoutJobsPort {
  /** Enqueues `payouts.send` in the caller's transaction, once per payout. */
  enqueueSend(payoutId: string, shopId: string, tx: Transaction): Promise<void>;
}

export interface PayoutEventsPort {
  /** Appends the envelope to the outbox in the caller's transaction. */
  append(event: EventEnvelope, tx: Transaction): Promise<void>;
}
