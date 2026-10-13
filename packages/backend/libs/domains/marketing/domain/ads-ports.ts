import type {
  AdClickRecord,
  AdStatusReason,
  MinuteAggregate,
} from '@marketplace-sandbox/contracts';
import type { CampaignStatus } from './campaign-state';
import type { SpamCounts } from './spam-filter';

/**
 * Ports of sponsored listings (S36 L1, D-6): `application/` depends on these tokens only; `infra/` binds the Sequelize,
 * Redis, Kafka, ClickHouse and R1 adapters, and the specs wrap the same tokens with fault-injecting decorators (VII.9).
 * Time comes from `Clock`/`CLOCK`; the SQL stores join the caller's transaction through the request/CLS context.
 */

export type { ClickRecord } from './click-record';

/** A store, cache or broker could not answer in time or failed. Never "not found". */
export class AdsDependencyUnavailableError extends Error {
  constructor(
    readonly dependency: string,
    cause?: unknown,
  ) {
    super(`${dependency} unavailable`);
    this.name = 'AdsDependencyUnavailableError';
    this.cause = cause;
  }
}

/** The unique index "one open campaign per product" refused an insert (a racing create won). */
export class OpenCampaignExistsError extends Error {
  constructor() {
    super('an open campaign already exists for the product');
    this.name = 'OpenCampaignExistsError';
  }
}

// ---- campaigns ------------------------------------------------------------------------------------------------------

export interface CampaignRecord {
  id: string;
  shopId: string;
  productId: string;
  category: string;
  cpcMinor: number;
  dailyBudgetMinor: number;
  currency: 'EUR';
  status: CampaignStatus;
  statusReason: AdStatusReason | null;
  campaignVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCampaign {
  shopId: string;
  productId: string;
  category: string;
  cpcMinor: number;
  dailyBudgetMinor: number;
}

export interface CampaignListQuery {
  status?: CampaignStatus;
  limit: number;
  after?: { createdAt: string; id: string };
}

export interface ServeCandidate {
  campaignId: string;
  shopId: string;
  productId: string;
  cpcMinor: number;
  dailyBudgetMinor: number;
  title: string;
  priceMinor: number;
  currency: string;
}

export interface HistoryEntry {
  campaignId: string;
  actorId: string | null;
  from: CampaignStatus | null;
  to: CampaignStatus;
  reason: string;
  campaignVersion: number;
}

export const CAMPAIGN_STORE = Symbol('CAMPAIGN_STORE');
export interface CampaignStore {
  /** Throws `OpenCampaignExistsError` when the product already has a non-ended campaign. */
  insert(campaign: NewCampaign, now: Date): Promise<CampaignRecord>;
  /** The shop is part of the predicate: another shop's campaign is absent (FR-003). */
  findForShop(id: string, shopId: string): Promise<CampaignRecord | null>;
  findManyByIds(ids: string[]): Promise<CampaignRecord[]>;
  list(shopId: string, query: CampaignListQuery): Promise<CampaignRecord[]>;
  /** `UPDATE … WHERE id AND shopId AND status = from`, version + 1; `null` when no row matched (a racing change won). */
  transition(
    id: string,
    shopId: string,
    from: CampaignStatus,
    to: CampaignStatus,
    reason: AdStatusReason | null,
    now: Date,
  ): Promise<CampaignRecord | null>;
  appendHistory(entry: HistoryEntry, now: Date): Promise<void>;
  /** `false` when the shop already holds the maximum of open campaigns. */
  reserveQuota(shopId: string): Promise<boolean>;
  releaseQuota(shopId: string): Promise<void>;
  /**
   * Sets the sponsored value of a product and returns the new `sponsorshipVersion`; `null` when the value did not change
   * (first call for a product inserts version 1).
   */
  setSponsorship(
    productId: string,
    shopId: string,
    sponsored: boolean,
    now: Date,
  ): Promise<number | null>;
  openByProduct(productId: string): Promise<CampaignRecord[]>;
  openByShop(shopId: string): Promise<CampaignRecord[]>;
  /** ACTIVE campaigns of eligible products and shops, best CPC first, at most `limit` (one SQL, marketing tables only). */
  serveCandidates(category: string, limit: number): Promise<ServeCandidate[]>;
}

// ---- read models (R3) -----------------------------------------------------------------------------------------------

export interface ProductSnapshot {
  productId: string;
  shopId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency: string;
  inStock: boolean;
  status: string;
  isSandbox: boolean;
  productVersion: number;
}

export interface ShopSnapshot {
  shopId: string;
  status: string;
  offboarding: boolean;
  deleted: boolean;
  shopVersion: number;
}

export const PRODUCT_SNAPSHOT_STORE = Symbol('PRODUCT_SNAPSHOT_STORE');
export interface ProductSnapshotStore {
  /** Version-guarded upsert: `false` for a duplicate or older version (no effect). */
  upsertIfNewer(snapshot: ProductSnapshot, now: Date): Promise<boolean>;
  find(productId: string): Promise<ProductSnapshot | null>;
}

export const SHOP_SNAPSHOT_STORE = Symbol('SHOP_SNAPSHOT_STORE');
export interface ShopSnapshotStore {
  upsertIfNewer(snapshot: ShopSnapshot, now: Date): Promise<boolean>;
  find(shopId: string): Promise<ShopSnapshot | null>;
}

// ---- R1 lookups -----------------------------------------------------------------------------------------------------

export interface ProductFacts {
  id: string;
  shopId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency: string;
  inStock: boolean;
  status: string;
  isSandbox: boolean;
  productVersion: number;
}

export const CATALOG_PORT = Symbol('CATALOG_PORT');
export interface CatalogPort {
  /** The product only if it belongs to the shop (R1 `getProductsByIds(ids, {shopId})`). */
  getShopProduct(
    productId: string,
    shopId: string,
  ): Promise<ProductFacts | null>;
}

export interface ShopFacts {
  id: string;
  status: string;
  shopVersion: number;
}

export const SHOP_DIRECTORY_PORT = Symbol('SHOP_DIRECTORY_PORT');
export interface ShopDirectoryPort {
  getShop(shopId: string): Promise<ShopFacts | null>;
}

// ---- hot-path stores ------------------------------------------------------------------------------------------------

export const IMPRESSION_MARKER = Symbol('IMPRESSION_MARKER');
export interface ImpressionMarker {
  /** `SET NX` with the marker lifetime: `true` when this call won the impression, `false` for a duplicate. Throws when the store fails. */
  claim(impressionId: string): Promise<boolean>;
  /** Removes the marker so the impression can still be counted (the recording failed). */
  release(impressionId: string): Promise<void>;
}

export const SPAM_COUNTERS = Symbol('SPAM_COUNTERS');
export interface SpamCounterKeys {
  ipHash: string;
  viewerHash: string;
  campaignId: string;
  at: Date;
}
export interface SpamCounters {
  /** Advances the three counters atomically each and returns the counts including this click. Throws when the store fails. */
  record(keys: SpamCounterKeys): Promise<SpamCounts>;
}

export const SPEND_COUNTER = Symbol('SPEND_COUNTER');
export interface SpendCounter {
  /** Counted clicks today per campaign (absent = 0). Throws when the store fails or is slower than its timeout. */
  readMany(campaignIds: string[], day: string): Promise<Map<string, number>>;
  increment(campaignId: string, day: string): Promise<void>;
}

export const CLICK_LOG = Symbol('CLICK_LOG');
export interface ClickLog {
  /** Idempotent publish to `ads.clicks` with a 1 s timeout; throws when the broker fails or is slower. */
  publish(key: string, record: AdClickRecord): Promise<void>;
}

// ---- analytics reads ------------------------------------------------------------------------------------------------

export interface ExactHourClicks {
  campaignId: string;
  /** `YYYY-MM-DDTHH` (UTC). */
  hour: string;
  clicks: number;
}

export const RAW_CLICK_READER = Symbol('RAW_CLICK_READER');
export interface RawClickReader {
  /** Distinct valid clicks per campaign-hour of one UTC day, first recorded verdict per click id. Throws when the log is unreadable. */
  exactValidClicksByHour(dayStartIso: string): Promise<ExactHourClicks[]>;
}

export const AGGREGATE_READER = Symbol('AGGREGATE_READER');
export interface AggregateReader {
  /** Σ clicks per campaign for one hour (`YYYY-MM-DDTHH`), read from the committed aggregates. */
  clicksByCampaign(
    hour: string,
  ): Promise<{ campaignId: string; clicks: number }[]>;
}

// ---- money ----------------------------------------------------------------------------------------------------------

export interface LedgerMovement {
  kind: 'AD_CHARGE' | 'ADJUSTMENT';
  reference: string;
  shopId: string;
  /** Positive charges the shop (shop line negative, fees positive), negative refunds it. Never zero. */
  chargeMinor: number;
}

export const LEDGER_PORT = Symbol('LEDGER_PORT');
export interface LedgerPort {
  /** One ledger-only transaction; `created: false` when the reference was posted before (success). */
  post(
    movement: LedgerMovement,
  ): Promise<{ journalId: string; created: boolean }>;
  /** The shop's balance (for specs and reports). */
  shopBalance(shopId: string): Promise<number>;
}

export interface BillingRunRecord {
  campaignId: string;
  hour: Date;
  state: 'PENDING' | 'CHARGED';
  source: 'stream' | 'reconciliation';
  clicks: number;
  billableClicks: number;
  cappedClicks: number;
  amountMinor: number;
  ledgerReference: string;
  journalId: string | null;
  chargedAt: Date | null;
  createdAt: Date;
}

export interface NewBillingRun {
  campaignId: string;
  hour: Date;
  state: 'PENDING' | 'CHARGED';
  source: 'stream' | 'reconciliation';
  clicks: number;
  billableClicks: number;
  cappedClicks: number;
  amountMinor: number;
  ledgerReference: string;
}

export interface AdjustmentRecord {
  campaignId: string;
  hour: Date;
  sequence: number;
  deltaClicks: number;
  deltaMinor: number;
  ledgerReference: string;
  state: 'PENDING' | 'POSTED';
  journalId: string | null;
  postedAt: Date | null;
}

export interface NewAdjustment {
  campaignId: string;
  hour: Date;
  sequence: number;
  deltaClicks: number;
  deltaMinor: number;
  ledgerReference: string;
  reconciliationRunId: string | null;
}

export interface ReconciliationRunRecord {
  id: string;
  day: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  reason: string | null;
  hoursChecked: number;
  hoursAdjusted: number;
  netDeltaMinor: number;
  driftRatio: number | null;
}

export interface StatementQuery {
  from: Date;
  to: Date;
  limit: number;
  /** Last hour of the previous page (`hour DESC` order). */
  before?: Date;
}

export interface StatementRow {
  run: BillingRunRecord;
  adjustments: AdjustmentRecord[];
}

export const BILLING_STORE = Symbol('BILLING_STORE');
export interface BillingStore {
  /** `ON CONFLICT DO NOTHING` on the (campaign, hour) key: `false` when a run already exists. */
  insertRun(run: NewBillingRun, now: Date): Promise<boolean>;
  findRun(campaignId: string, hour: Date): Promise<BillingRunRecord | null>;
  /** `PENDING → CHARGED` conditional; `false` when it was not pending. */
  markCharged(
    campaignId: string,
    hour: Date,
    journalId: string | null,
    now: Date,
  ): Promise<boolean>;
  /** Net billed for the campaign in `[dayStart, hourExclusive)`: run amounts plus posted adjustments of those hours. */
  netBilledBefore(
    campaignId: string,
    dayStart: Date,
    hourExclusive: Date,
  ): Promise<number>;
  /** Net billed for the whole UTC day of hours: CHARGED runs plus POSTED adjustments (the statement's `billedToday`). */
  netChargedInDay(campaignId: string, dayStart: Date): Promise<number>;
  runsOfDay(campaignId: string, dayStart: Date): Promise<BillingRunRecord[]>;
  adjustmentsOf(campaignId: string, hour: Date): Promise<AdjustmentRecord[]>;
  /** `false` when another reconciliation took the (campaign, hour, sequence) first. */
  insertAdjustment(adjustment: NewAdjustment, now: Date): Promise<boolean>;
  markAdjustmentPosted(
    campaignId: string,
    hour: Date,
    sequence: number,
    journalId: string,
    now: Date,
  ): Promise<boolean>;
  /** Campaigns that have a run or adjustment in the day, by id (for the reconciliation sweep). */
  campaignIdsWithRuns(dayStart: Date): Promise<string[]>;
  statement(campaignId: string, query: StatementQuery): Promise<StatementRow[]>;

  /** A new RUNNING row for the day; `null` when one is already running (the loser is skipped). */
  startReconciliation(
    day: string,
    now: Date,
  ): Promise<ReconciliationRunRecord | null>;
  /** Marks a RUNNING row older than `olderThan` FAILED/abandoned; returns how many. */
  abandonStaleReconciliations(day: string, olderThan: Date): Promise<number>;
  finishReconciliation(
    id: string,
    patch: Partial<
      Pick<
        ReconciliationRunRecord,
        | 'status'
        | 'reason'
        | 'hoursChecked'
        | 'hoursAdjusted'
        | 'netDeltaMinor'
        | 'driftRatio'
      >
    >,
    now: Date,
  ): Promise<void>;
}

/** The aggregate shape written to `ads.click-aggregates`. */
export type { MinuteAggregate };
