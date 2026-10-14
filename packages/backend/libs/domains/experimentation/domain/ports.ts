import type { FlagRulesetSnapshot } from '@marketplace-sandbox/contracts';
import type {
  FlagAction,
  FlagDefinitionBody,
  FlagStatus,
  StoredFlag,
} from './flag-types';

/** Ports of the flags capability (constitution I.1): the adapters live in `infra/`, nothing here imports Nest, an ORM or Redis. */
export const FLAG_REPOSITORY = Symbol('FLAG_REPOSITORY');
export const RULESET_PUBLISHER = Symbol('RULESET_PUBLISHER');
export const RULESET_SOURCE = Symbol('RULESET_SOURCE');
export const EVAL_COUNTER_STORE = Symbol('EVAL_COUNTER_STORE');

export interface AuditEntry {
  flagKey: string;
  action: FlagAction;
  actorId: string;
  requestId: string | null;
  before: unknown;
  after: unknown;
  at: Date;
}

export interface AuditRow {
  id: string;
  flagKey: string;
  action: FlagAction;
  actorId: string;
  requestId: string | null;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

export interface HistoryCursorKey {
  at: string;
  id: string;
}

export interface FlagListQuery {
  limit: number;
  afterKey?: string;
  status?: FlagStatus;
  includeArchived: boolean;
}

export interface NewFlag {
  key: string;
  status: FlagStatus;
  definition: FlagDefinitionBody;
  now: Date;
}

export interface FlagChange {
  key: string;
  expectedVersion: number;
  status: FlagStatus;
  definition: FlagDefinitionBody;
  now: Date;
}

/**
 * The flag tables. Every write method joins the active transaction (`TransactionRunner.run`); lock order is always the
 * ruleset row, then the flag row, so two writers can never deadlock.
 */
export interface FlagRepository {
  /** Locks the single ruleset row (creating it when absent) and returns its version. */
  lockRuleset(): Promise<number>;
  /** Adds one to the locked ruleset version and returns the new one. */
  bumpRuleset(): Promise<number>;
  findForUpdate(key: string): Promise<StoredFlag | null>;
  find(key: string): Promise<StoredFlag | null>;
  /** Flags that are not archived (the 500 cap counts these). */
  countLive(): Promise<number>;
  insert(flag: NewFlag): Promise<StoredFlag>;
  /** `UPDATE … WHERE key AND version`, asserting that exactly one row changed. */
  update(change: FlagChange): Promise<StoredFlag>;
  appendAudit(entry: AuditEntry): Promise<void>;
  list(query: FlagListQuery): Promise<StoredFlag[]>;
  history(
    key: string,
    limit: number,
    after?: HistoryCursorKey,
  ): Promise<AuditRow[]>;
  hasHistory(key: string): Promise<boolean>;
  /** Non-archived flags created before `cutoff` or expiring, with what the stale report needs. */
  staleCandidates(): Promise<StoredFlag[]>;
  /** The ruleset version and every non-archived flag, read as one consistent snapshot. */
  loadSnapshot(): Promise<FlagRulesetSnapshot>;
  rulesetVersion(): Promise<number>;
}

export interface RulesetPublisher {
  /** Writes the snapshot to the cache only when newer than what it holds, then pushes the version. */
  publish(snapshot: FlagRulesetSnapshot): Promise<void>;
  /** Version of the cached snapshot; null when there is none (or it cannot be read). */
  cachedVersion(): Promise<number | null>;
}

/** The cache holds bytes that are not a valid snapshot (AS-24). */
export class InvalidSnapshotError extends Error {
  constructor(reason: string) {
    super(`invalid ruleset snapshot: ${reason}`);
    this.name = 'InvalidSnapshotError';
  }
}

export interface RulesetSource {
  /** Cache first (500 ms), then the database (2 s); a corrupt cache entry throws `InvalidSnapshotError`. */
  read(): Promise<FlagRulesetSnapshot>;
  /** The database alone (2 s), for a cold start whose cache entry is corrupt. */
  readDatabase(): Promise<FlagRulesetSnapshot>;
}

export interface EvalCounterStore {
  /** Adds the counts to the per-day totals (one pipeline; the keys expire after 40 days). */
  add(day: string, counts: Record<string, number>): Promise<void>;
  /** Sum of the counts of the given days, per flag key. */
  totals(days: string[]): Promise<Record<string, number>>;
}
