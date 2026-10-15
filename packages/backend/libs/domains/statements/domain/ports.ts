import type { CommissionRateRule } from '@marketplace-sandbox/contracts';

/**
 * Ports of the statements (S16 plan "Project Structure"): `application/` depends on these tokens and
 * `infra/` binds them to Postgres. DTOs are plain data; no model or SQL type crosses a port.
 */
export const DEFAULT_SHOP_KEY = '00000000-0000-0000-0000-000000000000';

export const RATE_REPOSITORY = Symbol('RATE_REPOSITORY');
export const SHOP_DIRECTORY = Symbol('SHOP_DIRECTORY');
export const PERIOD_REPOSITORY = Symbol('PERIOD_REPOSITORY');
export const FACT_REPOSITORY = Symbol('FACT_REPOSITORY');
export const SNAPSHOT_REPOSITORY = Symbol('SNAPSHOT_REPOSITORY');
export const ADJUSTMENT_REPOSITORY = Symbol('ADJUSTMENT_REPOSITORY');
export const FINDING_REPOSITORY = Symbol('FINDING_REPOSITORY');
export const STATEMENT_READER = Symbol('STATEMENT_READER');

/** Shops exist in tenancy (R1); statements never reads a tenancy table. */
export interface ShopDirectory {
  existing(shopIds: string[]): Promise<Set<string>>;
}

/** A current belief that a new change overlaps. Range bounds are opaque `timestamptz` text (they can be infinite). */
export interface OverlappingBelief {
  id: string;
  changeId: string;
  rateBps: number;
  validLower: string;
  validUpper: string | null;
  reason: string | null;
  recordedBy: string | null;
  /** The whole new range lies inside this belief and its rate equals the new rate. */
  coversRange: boolean;
  /** The belief reaches before the new range / past it: the uncovered remainder is re-recorded. */
  hasLeft: boolean;
  hasRight: boolean;
  recordedFrom: string | null;
}

export interface NewBelief {
  changeId: string;
  shopKey: string;
  category: string;
  rateBps: number;
  /** `timestamptz` text, possibly `-infinity`. */
  validFrom: string;
  /** `null` is unbounded. */
  validTo: string | null;
  recordedFromIso: string;
  reason: string;
  recordedBy: string | null;
}

export interface RateBeliefRow {
  id: string;
  changeId: string;
  shopId: string | null;
  category: string;
  rateBps: number;
  validFrom: string | null;
  validTo: string | null;
  recordedFrom: string | null;
  recordedTo: string | null;
  reason: string | null;
  recordedBy: string | null;
}

export interface RateAsOfRow {
  rateBps: number;
  rule: CommissionRateRule;
  validFrom: string | null;
  validTo: string | null;
  recordedFrom: string | null;
}

export interface RateAsOfQuery {
  shopId: string;
  category: string;
  validAt: Date;
}

export interface HistoryFilter {
  /** `undefined`: any shop; `null`: the default rates only. */
  shopKey?: string;
  category?: string;
}

export interface HistoryAfter {
  /** `recordedFrom` of the last item as `timestamptz` text (`-infinity` for the beginning of time). */
  recordedFrom: string;
  id: string;
}

export type PeriodState = 'OPEN' | 'CLOSING' | 'CLOSED';

export interface PeriodRow {
  month: string;
  status: PeriodState;
  knowledgeCutoff: Date | null;
  closedAt: Date | null;
  shopCount: number | null;
  runId: string | null;
}

export interface RunRow {
  runId: string;
  month: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  knowledgeCutoff: Date;
  failureCode: string | null;
  details: Record<string, unknown> | null;
  batchesWritten: number;
  shopsWritten: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface PeriodRepository {
  /** Months whose period is `CLOSING` or `CLOSED` (`YYYY-MM`). */
  closingOrClosedMonths(): Promise<string[]>;
  /** The state of a month; a month with no row is `OPEN`. */
  statusOf(month: string): Promise<PeriodState>;
  find(month: string): Promise<PeriodRow | null>;
  /** Periods that have a row, newest month first, strictly before `before`. */
  list(before: string | null, limit: number): Promise<PeriodRow[]>;
  /** States of the months in `[from, to]` that have a row (a month without one is open). */
  statesBetween(from: string, to: string): Promise<Map<string, PeriodState>>;
  /** The month of the earliest sale or payout fact, or `null` when there is none. */
  earliestFactMonth(): Promise<string | null>;
  ensureRow(month: string): Promise<void>;
  /** `OPEN -> CLOSING` with the cutoff and the run, as a conditional update; `false` when the month was not open. */
  requestClose(month: string, cutoff: Date, runId: string): Promise<boolean>;
  /** `CLOSING -> CLOSED` for this run; `false` when it already happened or the run is not the period's. */
  finish(
    month: string,
    runId: string,
    shopCount: number,
    closedAt: Date,
  ): Promise<boolean>;
  /** `CLOSING -> OPEN` for this run (a failed run). */
  reopen(month: string, runId: string): Promise<boolean>;
  recordHistory(entry: {
    month: string;
    from: PeriodState;
    to: PeriodState;
    runId: string | null;
    actor: string;
    at: Date;
  }): Promise<void>;
  createRun(run: {
    runId: string;
    month: string;
    knowledgeCutoff: Date;
    startedAt: Date;
  }): Promise<void>;
  progressRun(runId: string, batches: number, shops: number): Promise<void>;
  finishRun(
    runId: string,
    status: 'COMPLETED' | 'FAILED',
    failureCode: string | null,
    details: Record<string, unknown> | null,
    finishedAt: Date,
  ): Promise<void>;
  lastRun(month: string): Promise<RunRow | null>;
  /** `findings` while one is open, `clean` after a verification with none, `unverified` before any. */
  reconciliationState(month: string): Promise<'clean' | 'findings' | 'unverified'>;
}

// ---------------------------------------------------------------------- facts (R3)

export type FactStream = 'orders' | 'payouts' | 'ledger';
export const FACT_STREAMS: readonly FactStream[] = [
  'orders',
  'payouts',
  'ledger',
];
export type ApplyOutcome = 'applied' | 'duplicate' | 'stale';

export interface SaleFactRow {
  orderId: string;
  lineId: string;
  orderVersion: number;
  shopId: string;
  productId: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  paidAt: Date;
  recordedAt: Date;
  appliedAt: Date;
  eventId: string;
}

export interface PayoutFactRow {
  payoutId: string;
  shopId: string;
  amountMinor: number;
  paidAt: Date;
  payoutVersion: number;
  recordedAt: Date;
  appliedAt: Date;
  eventId: string;
}

export interface LedgerFactRow {
  journalId: string;
  orderId: string | null;
  postedAt: Date;
  recordedAt: Date;
  appliedAt: Date;
  eventId: string;
  credits: { accountId: string; amountMinor: number }[];
}

export interface FactRepository {
  /** All lines of one order version; a lower version than stored is `stale`, the same version a `duplicate`. */
  applySaleFacts(
    orderId: string,
    orderVersion: number,
    facts: SaleFactRow[],
  ): Promise<ApplyOutcome>;
  applyPayoutFact(fact: PayoutFactRow): Promise<ApplyOutcome>;
  applyLedgerFact(fact: LedgerFactRow): Promise<ApplyOutcome>;
  /** Moves the stream's watermark forward (never back) to `occurredAt`. */
  advanceWatermark(
    stream: FactStream,
    occurredAt: Date,
    now: Date,
  ): Promise<void>;
  readWatermarks(): Promise<Record<FactStream, Date | null>>;
}

// ---------------------------------------------------------------------- reconciliation

export interface FindingRow {
  id: string;
  month: string;
  kind: import('./reconciliation').FindingKind;
  shopId: string | null;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
  status: 'OPEN' | 'CLEARED';
  openedAt: string;
  clearedAt: string | null;
}

export interface LedgerComparison {
  /** Per shop with at least one ledger journal for the month's orders: frozen net against credited. */
  net: { shopId: string; expectedMinor: number; actualMinor: number }[];
  /** Total frozen commission against the `PLATFORM_FEES` credits; `null` when no journal is linked to the month. */
  fees: { expectedMinor: number; actualMinor: number } | null;
  /** Per shop: gross of the month's orders no ledger journal refers to. */
  unjournalled: { shopId: string; grossMinor: number }[];
  /** Journals posted in the month for an order the statements have no sale fact for. */
  journalsWithoutSale: number;
  /** Journals with no order reference: skipped and counted. */
  unlinkedJournals: number;
}

export interface FindingRepository {
  ledgerComparison(month: string): Promise<LedgerComparison>;
  /**
   * Opens or refreshes one finding per (month, kind, shop), clears the open findings of `kinds` that are not in
   * `drafts`; returns those newly opened (or reopened) by this run.
   */
  sync(
    month: string,
    kinds: import('./reconciliation').FindingKind[],
    drafts: import('./reconciliation').FindingDraft[],
    now: Date,
  ): Promise<import('./reconciliation').FindingDraft[]>;
  markVerified(month: string, now: Date): Promise<void>;
  page(
    month: string,
    before: { openedAt: string; id: string } | null,
    limit: number,
  ): Promise<FindingRow[]>;
}

// ---------------------------------------------------------------------- export

export const EXPORT_SOURCE = Symbol('EXPORT_SOURCE');

export interface SaleExportRow {
  orderId: string;
  lineId: string;
  /** `2026-03-15T12:00:00.123456Z`; also the keyset position of the row. */
  paidAt: string;
  productId: string;
  category: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  rateBps: number | null;
  commissionMinor: number | null;
}

export interface SaleExportRequest {
  shopId: string;
  month: string;
  knownAt: Date;
  appliedBy: boolean;
  after: { paidAt: string; orderId: string; lineId: string } | null;
  limit: number;
  /** Statement timeout of this batch's query. */
  timeoutMs: number;
}

export interface ExportSource {
  /** The next batch of effective, priced sale lines in `paidAt, orderId, lineId` order, read on the replica. */
  saleBatch(request: SaleExportRequest): Promise<SaleExportRow[]>;
}

// ---------------------------------------------------------------------- statements

/** Where the figures of a month are priced from: the knowledge instant on both axes. */
export interface AggregateRequest {
  shopId: string;
  month: string;
  /** Rates known at this instant, facts recorded at or before it. */
  knownAt: Date;
  /** Snapshots only: also require the fact to have been applied by `knownAt`, so a resumed run is deterministic. */
  appliedBy?: boolean;
}

export interface Aggregate {
  grossMinor: number;
  commissionMinor: number;
  lineCount: number;
  unpricedLineCount: number;
  payoutsPaidMinor: number;
}

export interface ShopAggregate extends Aggregate {
  shopId: string;
}

export interface StatementReader {
  /** Figures of one shop and month; `replica` allows the reporting replica for closed months. */
  aggregate(request: AggregateRequest): Promise<Aggregate>;
  /** Shops with sales or paid payouts in the month (keyset on `shopId`), each priced; used by the close. */
  aggregateShops(
    month: string,
    knownAt: Date,
    afterShopId: string | null,
    limit: number,
  ): Promise<ShopAggregate[]>;
  /** Sale lines of the month that no rate resolves (the close refuses them). */
  countUnpriced(month: string, knownAt: Date): Promise<number>;
  /** Months of the shop's list: the current month, months not closed, and months with a snapshot; newest first. */
  listMonths(
    shopId: string,
    currentMonth: string,
    before: string | null,
    limit: number,
  ): Promise<string[]>;
}

export interface SnapshotRow {
  shopId: string;
  month: string;
  grossMinor: number;
  commissionMinor: number;
  netMinor: number;
  lineCount: number;
  payoutsPaidMinor: number;
  adjGrossMinor: number;
  adjCommissionMinor: number;
  adjLineCount: number;
  adjPayoutsMinor: number;
  knowledgeCutoff: Date;
  runId: string | null;
}

export interface SnapshotRepository {
  find(
    shopId: string,
    month: string,
    options?: { primary?: boolean },
  ): Promise<SnapshotRow | null>;
  /** Writes the batch (`ON CONFLICT DO NOTHING`: a resumed run is harmless); returns the rows actually inserted. */
  writeBatch(
    month: string,
    rows: ShopAggregate[],
    cutoff: Date,
    runId: string,
    computedAt: Date,
  ): Promise<number>;
  countForMonth(month: string): Promise<number>;
  /** A failed run removes its own unpublished rows (the store refuses this once the month is closed). */
  deleteForMonth(month: string): Promise<void>;
  /** Every snapshot of a month, keyset on `shopId` (verification). */
  page(
    month: string,
    afterShopId: string | null,
    limit: number,
  ): Promise<SnapshotRow[]>;
}

export interface AdjustmentFilter {
  /** Adjustments booked into this month. */
  bookedMonth?: string;
  /** Adjustments that refer to this month. */
  refersToMonth?: string;
  /** Only those created at or before this instant (as-known-at answers). */
  createdAtOrBefore?: Date;
  /** Read from the primary: the caller is about to decide on what it sees (booking), or just wrote. */
  primary?: boolean;
}

export interface NewAdjustment {
  shopId: string;
  refersToMonth: string;
  bookedMonth: string;
  causeKind: 'rate_change' | 'late_sale' | 'late_payout';
  causeRef: string;
  grossDeltaMinor: number;
  commissionDeltaMinor: number;
  lineCountDelta: number;
  payoutsPaidDeltaMinor: number;
  reason: string;
  createdAt: Date;
}

export interface AdjustmentRepository {
  forShop(
    shopId: string,
    filter: AdjustmentFilter,
  ): Promise<import('./statement-view').AdjustmentFigures[]>;
  /** Serialises the adjustment work of one shop and month until the surrounding transaction ends. */
  lockShopMonth(shopId: string, month: string): Promise<void>;
  /** Books it once per `(shop, month, causeKind, causeRef)`; the id, or `null` when that cause was already booked. */
  insert(adjustment: NewAdjustment): Promise<string | null>;
}

/** Cooperative stop (AS-80): long work checks it between batches and leaves its state resumable. */
export const STOP_SIGNAL = Symbol('STOP_SIGNAL');
export interface StopSignal {
  isStopping(): boolean;
}

/** Whether the consumer group of a stream has read everything on its topic (S53 consumer lag, an edge). */
export const STREAM_LAG = Symbol('STREAM_LAG');
export interface StreamLag {
  isCaughtUp(stream: FactStream): Promise<boolean>;
}

export interface RateRepository {
  /** Serialises the writers of one (shop, category) until the surrounding transaction ends. */
  lockWriters(shopKey: string, category: string): Promise<void>;
  findOverlapping(
    shopKey: string,
    category: string,
    validFrom: string,
    validTo: string | null,
    rateBps: number,
  ): Promise<OverlappingBelief[]>;
  /** Highest `recordedFrom` of any belief of (shop, category) in microseconds; `null` when there is none. */
  lastRecordedMicros(shopKey: string, category: string): Promise<bigint | null>;
  closeRecordedPeriod(id: string, atIso: string): Promise<void>;
  insertBelief(belief: NewBelief): Promise<string>;
  /** Whether the current default `*` beliefs cover all time without a hole. */
  defaultCoversAllTime(): Promise<boolean>;
  history(
    filter: HistoryFilter,
    after: HistoryAfter | null,
    limit: number,
  ): Promise<RateBeliefRow[]>;
  asOf(
    shopId: string | null,
    category: string,
    validAt: Date,
    knownAt: Date,
  ): Promise<RateAsOfRow | null>;
  asOfBatch(
    queries: RateAsOfQuery[],
    knownAt: Date,
  ): Promise<{ rateBps: number; rule: CommissionRateRule }[]>;
  /** The reason text recorded with a change (any of its beliefs), or `null` when the change is unknown. */
  reasonOfChange(changeId: string): Promise<string | null>;
}
