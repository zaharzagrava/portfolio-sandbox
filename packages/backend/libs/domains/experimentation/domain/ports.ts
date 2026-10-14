import type { FlagRulesetSnapshot } from '@marketplace-sandbox/contracts';
import type { StoredEvent } from './event-schema';
import type {
  ExperimentAction,
  ExperimentDefinition,
  ExperimentStatus,
  ExperimentUnit,
  ListedExperiment,
  RunningExperiment,
  StoredExperiment,
} from './experiment-types';
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

// ---- S39 analytics and experiments ----

export const EXPERIMENT_REPOSITORY = Symbol('EXPERIMENT_REPOSITORY');
export const EVENT_STORE = Symbol('EVENT_STORE');
export const EVENT_PRODUCER = Symbol('EVENT_PRODUCER');
export const RUNNING_SET_CACHE = Symbol('RUNNING_SET_CACHE');

export interface ExperimentAuditEntry {
  experimentKey: string;
  action: ExperimentAction;
  actorId: string;
  requestId: string | null;
  before: unknown;
  after: unknown;
  at: Date;
}

export interface ExperimentAuditRow {
  id: string;
  action: ExperimentAction;
  actorId: string;
  requestId: string | null;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

export interface ExperimentCursorKey {
  createdAt: string;
  key: string;
}

export interface ExperimentListQuery {
  limit: number;
  after?: ExperimentCursorKey;
  status?: ExperimentStatus;
}

export interface NewExperiment {
  key: string;
  definition: ExperimentDefinition;
  now: Date;
}

export interface ExperimentChange {
  key: string;
  expectedVersion: number;
  definition: ExperimentDefinition;
  now: Date;
}

export interface ExperimentTransition {
  key: string;
  from: ExperimentStatus;
  to: Exclude<ExperimentStatus, 'draft'>;
  actorId: string;
  now: Date;
}

/** A start whose range overlaps a running experiment of the layer (the database's exclusion constraint fired). */
export class LayerOverlapError extends Error {
  constructor() {
    super('layer range overlaps a running experiment');
    this.name = 'LayerOverlapError';
  }
}

/**
 * The experiment tables. Every write method joins the active transaction (`TransactionRunner.run`). Locks are always taken
 * in the order: advisory lock for creates, then the experiment row.
 */
export interface ExperimentRepository {
  /** Transaction-scoped advisory lock that serialises creates, which makes the 200 cap exact. */
  lockCreates(): Promise<void>;
  findForUpdate(key: string): Promise<StoredExperiment | null>;
  find(key: string): Promise<StoredExperiment | null>;
  count(): Promise<number>;
  insert(experiment: NewExperiment): Promise<StoredExperiment>;
  /** `UPDATE … WHERE key AND version`, bumping the version and asserting that exactly one row changed. */
  update(change: ExperimentChange): Promise<StoredExperiment>;
  /** `UPDATE … WHERE key AND status = from`; throws `LayerOverlapError` when the exclusion constraint fires. */
  transition(change: ExperimentTransition): Promise<StoredExperiment>;
  appendAudit(entry: ExperimentAuditEntry): Promise<void>;
  list(query: ExperimentListQuery): Promise<ListedExperiment[]>;
  history(
    key: string,
    limit: number,
    after?: HistoryCursorKey,
  ): Promise<ExperimentAuditRow[]>;
  /** Running experiments as assignment needs them. */
  listRunning(): Promise<RunningExperiment[]>;
  /** Key of a running experiment of the layer whose range overlaps `[from, to)`, if any. */
  findBlocking(layer: string, from: number, to: number): Promise<string | null>;
}

export interface ResultsQuery {
  experimentKey: string;
  metric: string;
  unit: ExperimentUnit;
  /** The variant keys the experiment defines: an exposure naming any other is excluded and counted. */
  variants: string[];
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Counts of one results read, all from one consistent query of the de-duplicated events. `unattributable` and
 * `unknownVariant` count exposure events; `crossoverUnits` counts units.
 */
export interface ResultsCounts {
  /** Per variant of the query: units counted at their first exposure (crossover units excluded) and how many converted. */
  variants: { variant: string; exposures: number; conversions: number }[];
  /** Units exposed to more than one (known) variant inside the window. */
  crossoverUnits: number;
  /** Exposures of a `user` experiment without a user id. */
  unattributable: number;
  /** Exposures naming a variant the experiment does not define. */
  unknownVariant: number;
}

/** One event as every read sees it: the first received copy of its `event_id`. */
export interface CollapsedEvent {
  event_id: string;
  name: string;
  anonymous_id: string;
  user_id: string;
  ts: string;
  props: Record<string, string>;
}

/** Analytical event store (ClickHouse): every read collapses copies of an event to the first received one. */
export interface EventStore {
  readResults(query: ResultsQuery): Promise<ResultsCounts>;
  /** The collapsed events with these ids (at most 500), in no particular order. */
  readEvents(eventIds: string[]): Promise<CollapsedEvent[]>;
  /** Number of distinct events stored, whatever the number of copies. */
  countEvents(): Promise<number>;
}

/** Produces accepted events on `analytics.events`; rejects when the stream does not acknowledge in time. */
export interface EventProducer {
  sendMany(events: StoredEvent[]): Promise<void>;
}

/** The running set: a short per-instance memory over the shared cache over the database. */
export interface RunningSetCache {
  get(loader: () => Promise<RunningExperiment[]>): Promise<RunningExperiment[]>;
  /** Drops the shared entry and this instance's memory; never throws (the next read repairs it). */
  invalidate(): Promise<void>;
}
