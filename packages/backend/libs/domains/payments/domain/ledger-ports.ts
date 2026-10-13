import type { Transaction } from 'sequelize';
import type {
  ReconciliationIssue,
  ReconciliationRun,
} from '@marketplace-sandbox/contracts';

/**
 * Ports of the ledger (S14 contracts/services.md "Domain ports"): `application/` reaches the stores only through these
 * tokens; the Sequelize, Redis, DynamoDB and Stripe adapters live in `infra/`.
 */

/** A journal header as stored: unique per (kind, reference), identified by a deterministic id. */
export interface JournalHeader {
  id: string;
  kind: string;
  reference: string;
  currency: string;
  postedAt: Date;
  fingerprint: string;
  paymentId: string | null;
  orderId: string | null;
  paymentRef: string | null;
  refundRef: string | null;
  userId: string | null;
  /** `SALE` only: the clearing credit that settlement splits. */
  clearingMinor: number | null;
  /** `SALE` and `REFUND`: the payment total that was captured or refunded (what the provider's statement shows). */
  amountMinor: number | null;
  /** `REFUND` of a settled sale: the settlement journal it reversed. */
  reversesJournalId: string | null;
  /** `ADJUSTMENT` from a resolved issue: the closed day it corrects. */
  correctsDay: string | null;
}

export interface EntryRow {
  journalId: string;
  kind: string;
  paymentId: string | null;
  accountId: string;
  shard: number;
  amountMinor: number;
  currency: string;
  postedAt: Date;
}

export interface StoredLine {
  accountId: string;
  shard: number;
  amountMinor: number;
}

export interface JournalStore {
  /** `INSERT … ON CONFLICT (kind, reference) DO NOTHING`; a duplicate returns the stored header (R-1). */
  insertHeader(
    header: JournalHeader,
    tx: Transaction,
  ): Promise<{ created: true } | { created: false; existing: JournalHeader }>;
  insertEntries(rows: EntryRow[], tx: Transaction): Promise<void>;
  findHeader(
    kind: string,
    reference: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null>;
  findByPayment(
    kind: 'SALE' | 'REFUND',
    paymentId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null>;
  findSettlementByOrder(
    orderId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null>;
  findSaleByOrder(
    orderId: string,
    tx?: Transaction,
  ): Promise<JournalHeader | null>;
  entriesOf(journalId: string, tx?: Transaction): Promise<StoredLine[]>;
  /** Serializes the settlement and the refund of one payment (research R-6). */
  lockPayment(paymentId: string, tx: Transaction): Promise<void>;
}

export interface BalanceDelta {
  accountId: string;
  shard: number;
  amountMinor: number;
  /** The row must stay at or above zero, decided by the same statement that moves it. */
  guarded: boolean;
}

export interface AppliedBalance {
  accountId: string;
  shard: number;
  balanceMinor: number;
  version: number;
}

export interface BalanceStore {
  /** `SET LOCAL lock_timeout / statement_timeout` for the rest of the caller's transaction (FR-021). */
  bound(
    tx: Transaction,
    limits: { lockTimeoutMs: number; statementTimeoutMs: number },
  ): Promise<void>;
  /**
   * One statement per row, in the order given (ascending, see `lock-order.ts`). Throws `InsufficientBalance` when a
   * guarded row would go below zero and `JournalInvalid('balance_overflow')` outside the safe-integer range.
   */
  apply(
    currency: string,
    deltas: BalanceDelta[],
    postedAt: Date,
    tx: Transaction,
  ): Promise<AppliedBalance[]>;
  /** Logical balance (sum of the shards) per account; an account without a row is `0`. */
  read(
    accountIds: string[],
    currency: string,
    tx?: Transaction,
  ): Promise<Map<string, number>>;
  listSellers(
    input: {
      currency: string;
      minMinor: number;
      limit: number;
      after?: string;
    },
    tx?: Transaction,
  ): Promise<{ accountId: string; balanceMinor: number }[]>;
  /** Shards above 0 with a non-zero balance (the sweep's work list). */
  sweepableShards(
    accountId: string,
    currency: string,
    tx: Transaction,
  ): Promise<{ shard: number; balanceMinor: number }[]>;
}

/** One account shard in a balance read-model store: an absolute balance with the version that produced it. */
export interface ReadModelLine {
  accountId: string;
  shard: number;
  currency: string;
  balanceMinor: number;
  version: number;
  projectedAt: Date;
}

/**
 * A copy of the running balances kept for reads (S14 research R-8): written only by the projector, version-guarded,
 * rebuildable. Two implementations: the hot one (Redis, expiring) and the durable one (DynamoDB).
 */
export interface BalanceReadModelStore {
  /** Applies the line only when its version is newer than the stored one. */
  putIfNewer(line: ReadModelLine): Promise<'applied' | 'stale' | 'duplicate'>;
  /** Every stored shard of an account (empty when nothing is stored). */
  get(accountId: string): Promise<ReadModelLine[]>;
  /** Writes the line whatever is stored: the checker's repair of a corrupted value (never the projector's path). */
  overwrite(line: ReadModelLine): Promise<void>;
}

/** How far the projector has got: the posting time of the newest journal it applied (the lag gauge reads it). */
export interface ProjectionProgress {
  record(postedAt: Date): Promise<void>;
  last(): Promise<Date | null>;
}

/** Locks that keep a scheduled job to one runner at a time across replicas (an optimization; jobs are idempotent). */
export interface JobLock {
  /** The token of the lock, or null when another runner holds it. */
  acquire(name: string, ttlMs: number): Promise<string | null>;
  release(name: string, token: string): Promise<void>;
}

export interface CheckedBalanceRow {
  accountId: string;
  shard: number;
  currency: string;
  balanceMinor: number;
  version: number;
}

/** SQL of the housekeeping jobs (partitions, invariant checks, backfill); the services above it hold the rules. */
export interface LedgerMaintenanceStore {
  ensurePartitions(fromMonth: string, monthsAhead: number): Promise<void>;
  defaultPartitionRows(): Promise<number>;
  unbalancedJournals(
    from: Date,
    to: Date,
    limit: number,
  ): Promise<{ journalId: string; sum: string }[]>;
  /** (account, shard) rows of the window whose running balance is not checkpoint + entries since. */
  balanceDrift(
    from: Date,
    to: Date,
    limit: number,
  ): Promise<
    {
      accountId: string;
      shard: number;
      currency: string;
      expected: string;
      actual: string;
    }[]
  >;
  touchedBalances(
    from: Date,
    to: Date,
    after: { accountId: string; shard: number; currency: string } | null,
    limit: number,
  ): Promise<CheckedBalanceRow[]>;
  advanceCheckpoints(from: Date, to: Date, exclude: string[]): Promise<number>;
  /** Posting time of the oldest journal after `after` (or null when there is none). */
  oldestPostedAfter(after: Date): Promise<Date | null>;
  /** One batch of the backfill in its own transaction (lock limit 3 s); resumable through the cursor row. */
  backfillBatch(input: {
    batch: number;
    now: Date;
  }): Promise<{ rows: number; journals: number; finished: boolean }>;
  backfillFinished(): Promise<boolean>;
  markBackfillFinished(now: Date): Promise<void>;
  seedCheckpoints(through: Date): Promise<void>;
  balancePage(
    after: { accountId: string; shard: number; currency: string } | null,
    limit: number,
  ): Promise<CheckedBalanceRow[]>;
}

/** The provider could not answer within the bounds (timeout, `429`, `5xx`, connection): the run fails, the job retries. */
export class ProviderUnavailableError extends Error {
  constructor(message = 'the payment provider is unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export interface StatementPage {
  /** Raw, untrusted lines: `reconciliation-matcher.parseStatementLine` validates each. */
  lines: unknown[];
  nextCursor: string | null;
}

/** The provider's statement behind a port (S14 FR-028): paged, lazily advanced, no retry of its own. */
export interface ProviderStatement {
  listLines(input: {
    fromInclusive: Date;
    toExclusive: Date;
    cursor: string | null;
    limit: number;
  }): Promise<StatementPage>;
  /** The provider's record of one of our references, wherever in time it happened (day boundaries), or null. */
  findByReference(reference: string): Promise<unknown | null>;
}

export interface RunRecord {
  id: string;
  provider: string;
  day: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  /** The lease token: a run can only be finished by the attempt that claimed it. */
  startedAt: Date;
  leaseUntil: Date | null;
  failureCode: string | null;
  providerLines: number;
  ledgerJournals: number;
  matched: number;
  issues: number;
  skipped: number;
  finishedAt: Date | null;
}

export type ClaimResult =
  | { kind: 'claimed'; run: RunRecord }
  | { kind: 'completed'; run: RunRecord }
  | { kind: 'running'; run: RunRecord };

export interface OpenMissingIssue {
  id: string;
  kind: 'MISSING_IN_LEDGER' | 'MISSING_AT_PROVIDER';
  reference: string;
  details: Record<string, unknown>;
}

/** The reconciliation's own tables (runs, issues, staging) and its read-only view of the ledger's references. */
export interface ReconciliationStore {
  claim(input: {
    provider: string;
    day: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ClaimResult>;
  /** Extends the lease; false when this attempt no longer holds it. */
  extendLease(run: RunRecord, leaseUntil: Date): Promise<boolean>;
  stageIssues(
    runId: string,
    issues: {
      kind: string;
      reference: string;
      details: Record<string, unknown>;
    }[],
  ): Promise<void>;
  markSeen(runId: string, references: string[]): Promise<void>;
  /** `SALE` by `paymentRef` and `REFUND` by `refundRef`, wherever in time they were posted. */
  ledgerSides(references: string[]): Promise<LedgerSideRecord[]>;
  countDayJournals(fromInclusive: Date, toExclusive: Date): Promise<number>;
  /** Day journals whose reference was not seen in the statement, by keyset on the journal id. */
  unseenJournals(input: {
    runId: string;
    fromInclusive: Date;
    toExclusive: Date;
    afterId: string | null;
    limit: number;
  }): Promise<(LedgerSideRecord & { id: string })[]>;
  openMissingIssues(
    fromDay: string,
    toDayExclusive: string,
  ): Promise<OpenMissingIssue[]>;
  /** One transaction (the caller's): staged issues become issues; returns the ones that are new. */
  promoteStaged(
    run: RunRecord,
    now: Date,
    tx: Transaction,
  ): Promise<{ id: string; kind: string; reference: string }[]>;
  autoResolve(
    issueIds: string[],
    now: Date,
    tx: Transaction,
  ): Promise<string[]>;
  finishRun(
    run: RunRecord,
    counts: {
      providerLines: number;
      ledgerJournals: number;
      matched: number;
      skipped: number;
    },
    now: Date,
    tx: Transaction,
  ): Promise<{ issues: number } | null>;
  purgeScratch(runId: string, tx?: Transaction): Promise<void>;
  failRun(
    run: RunRecord,
    code: 'provider_unavailable' | 'interrupted' | 'internal',
    now: Date,
  ): Promise<void>;
  completedDays(
    provider: string,
    fromDay: string,
    toDayExclusive: string,
  ): Promise<string[]>;
  openIssueStats(
    now: Date,
  ): Promise<{ byKind: Record<string, number>; oldestAgeSeconds: number }>;

  // The operator API (S14 FR-038…FR-041): keyset lists, a conditional resolution, its history.
  listRuns(input: {
    limit: number;
    after: TimeKey | null;
  }): Promise<{ item: ReconciliationRun; t: string }[]>;
  listIssues(input: {
    status?: string;
    kind?: string;
    day?: string;
    limit: number;
    after: TimeKey | null;
  }): Promise<{ item: ReconciliationIssue; t: string }[]>;
  findIssue(
    id: string,
    tx?: Transaction,
  ): Promise<{ status: 'OPEN' | 'RESOLVED'; day: string } | null>;
  /** `OPEN -> RESOLVED` as one conditional update; null when the issue is not open (or absent). */
  resolveOpenIssue(
    input: {
      id: string;
      resolution: 'explained' | 'adjusted';
      note: string;
      actor: string;
      now: Date;
    },
    tx: Transaction,
  ): Promise<ReconciliationIssue | null>;
  linkAdjustment(
    issueId: string,
    journalId: string,
    tx: Transaction,
  ): Promise<void>;
  addHistory(
    input: {
      issueId: string;
      at: Date;
      actor: string;
      resolution: string;
      note: string | null;
    },
    tx: Transaction,
  ): Promise<void>;
}

/** Keyset position: a timestamp as Postgres prints it (microseconds) and the row id. */
export interface TimeKey {
  t: string;
  id: string;
}

export interface LedgerSideRecord {
  kind: 'SALE' | 'REFUND';
  reference: string;
  amountMinor: number;
  currency: string;
}

/** The payout destination of a shop at the payment provider (a payments-owned table; written by S15). */
export interface ProviderAccountRepository {
  findAccountId(shopId: string): Promise<string | null>;
}

export const JOURNAL_STORE = Symbol('JOURNAL_STORE');
export const BALANCE_STORE = Symbol('BALANCE_STORE');
export const LEDGER_MAINTENANCE_STORE = Symbol('LEDGER_MAINTENANCE_STORE');
export const PROJECTION_PROGRESS = Symbol('PROJECTION_PROGRESS');
export const JOB_LOCK = Symbol('JOB_LOCK');
export const RECONCILIATION_STORE = Symbol('RECONCILIATION_STORE');
export const PROVIDER_STATEMENT = Symbol('PROVIDER_STATEMENT');
export const BALANCE_HOT_STORE = Symbol('BALANCE_HOT_STORE');
export const BALANCE_DURABLE_STORE = Symbol('BALANCE_DURABLE_STORE');
export const PROVIDER_ACCOUNT_REPOSITORY = Symbol(
  'PROVIDER_ACCOUNT_REPOSITORY',
);
