import type { VersionStatus } from '@marketplace-sandbox/contracts';
import type { Admission, BreakerView } from './breaker';
import type {
  FunctionInput,
  SandboxResult,
  TestCase,
  VerdictRecord,
} from './contract';

/** Ports of the `shop-functions` domain (contracts/internal.md). Adapters live in `infra/`; tokens are not exported from the barrel. */

export interface FunctionRecord {
  id: string;
  shopId: string;
  name: string;
  enabled: boolean;
  activeVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunctionView extends FunctionRecord {
  testCount: number;
  latestVersion: number | null;
}

export interface VersionRecord {
  functionId: string;
  version: number;
  source: string;
  sourceHash: string;
  status: VersionStatus;
  verdicts: VerdictRecord[] | null;
  rejectionReason: 'judge_unavailable' | null;
  judgeAttempts: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  judgedAt: Date | null;
}

export interface TimelineEntry {
  status: VersionStatus;
  at: Date;
  actorId: string | null;
  reason: string | null;
}

/** What the checkout path needs of an enabled function with an active version. */
export interface ActiveFunction {
  id: string;
  shopId: string;
  name: string;
  version: number;
  source: string;
  sourceHash: string;
}

export interface KeysetPage<T> {
  items: T[];
  nextCursor: string | null;
}

export const FUNCTION_REPOSITORY = Symbol('SHOP_FUNCTIONS_FUNCTION_REPOSITORY');
export const VERSION_REPOSITORY = Symbol('SHOP_FUNCTIONS_VERSION_REPOSITORY');
export const TEST_CASE_REPOSITORY = Symbol(
  'SHOP_FUNCTIONS_TEST_CASE_REPOSITORY',
);
export const ACTIVE_SET_CACHE = Symbol('SHOP_FUNCTIONS_ACTIVE_SET_CACHE');
export const MEMO_CACHE = Symbol('SHOP_FUNCTIONS_MEMO_CACHE');
export const BREAKER_STORE = Symbol('SHOP_FUNCTIONS_BREAKER_STORE');
export const FUNCTION_RUNNER = Symbol('SHOP_FUNCTIONS_FUNCTION_RUNNER');
export const SHOP_FUNCTIONS_ENTITLEMENTS = Symbol(
  'SHOP_FUNCTIONS_ENTITLEMENTS',
);
export const JUDGE_REQUESTS = Symbol('SHOP_FUNCTIONS_JUDGE_REQUESTS');

/** Every principal-driven method takes the shop (III.4). Transactions come from the caller (`TransactionRunner.run`). */
export interface FunctionRepository {
  /** Per-shop advisory lock, cap and case-insensitive name; throws `function_limit_reached` / `function_name_taken`. */
  create(
    shopId: string,
    name: string,
    maxFunctions: number,
  ): Promise<FunctionRecord>;
  list(
    shopId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<FunctionView>>;
  find(shopId: string, functionId: string): Promise<FunctionView | null>;
  /** `SELECT … FOR UPDATE` on the function row. */
  lock(shopId: string, functionId: string): Promise<FunctionRecord | null>;
  delete(shopId: string, functionId: string): Promise<boolean>;
  /** `null` = no such function; `false` = already in that state; `true` = changed. */
  setEnabled(
    shopId: string,
    functionId: string,
    enabled: boolean,
  ): Promise<boolean | null>;
  /** Enabled functions that have an active version, for all the shops at once, in name order. */
  activeFor(shopIds: string[]): Promise<ActiveFunction[]>;
}

export interface TestCaseRepository {
  /** Replaces the current (editable) suite; `false` when the function is not the shop's. */
  replaceCurrent(
    shopId: string,
    functionId: string,
    tests: TestCase[],
  ): Promise<boolean>;
  current(shopId: string, functionId: string): Promise<TestCase[] | null>;
}

export type ActivateOutcome = 'activated' | 'not_activatable' | 'not_found';
export type JudgeApplied =
  | { outcome: 'active' | 'superseded' | 'rejected'; shopId: string }
  | { outcome: 'noop' };
export interface JudgeClaim {
  shopId: string;
  source: string;
  cases: TestCase[];
}

export interface VersionRepository {
  /** Next number under the function row lock; frozen copy of the suite; history row. `null` = no such function. */
  submit(args: {
    shopId: string;
    functionId: string;
    userId: string;
    source: string;
    sourceHash: string;
    maxVersions: number;
    now: Date;
  }): Promise<{ version: number; createdAt: Date } | null>;
  list(
    shopId: string,
    functionId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<VersionRecord> | null>;
  get(
    shopId: string,
    functionId: string,
    version: number,
  ): Promise<VersionRecord | null>;
  timeline(functionId: string, version: number): Promise<TimelineEntry[]>;
  activate(args: {
    shopId: string;
    functionId: string;
    version: number;
    actorId: string;
    now: Date;
  }): Promise<ActivateOutcome>;
  /** `QUEUED → TESTING` (history row), or the data of a `TESTING` version again; `null` = missing or terminal. */
  claimForJudge(
    functionId: string,
    version: number,
    now: Date,
  ): Promise<JudgeClaim | null>;
  applyJudgeResult(args: {
    functionId: string;
    version: number;
    verdicts: VerdictRecord[];
    passed: boolean;
    now: Date;
  }): Promise<JudgeApplied>;
  /** Versions `QUEUED`/`TESTING` untouched since `before`, oldest first. */
  findStuck(
    before: Date,
    limit: number,
  ): Promise<
    Array<{
      functionId: string;
      version: number;
      judgeAttempts: number;
      updatedAt: Date;
    }>
  >;
  /** Conditional `judgeAttempts + 1` and `updatedAt = now`; `false` when another runner got there first. */
  rerequest(
    functionId: string,
    version: number,
    seenAttempts: number,
    before: Date,
    now: Date,
  ): Promise<boolean>;
  /** `REJECTED judge_unavailable` with a null-actor history row; `shopId` is `null` when nothing changed. */
  exhaust(
    functionId: string,
    version: number,
    before: Date,
    now: Date,
  ): Promise<{ shopId: string } | null>;
  backlog(now: Date): Promise<{ count: number; oldestAgeSeconds: number }>;
}

export interface ActiveSetCache {
  getMany(shopIds: string[]): Promise<Map<string, ActiveFunction[]>>;
  setMany(entries: Map<string, ActiveFunction[]>): Promise<void>;
  drop(shopId: string): Promise<void>;
}

export interface MemoCache {
  get(key: string): Promise<number[] | null>;
  set(key: string, discounts: number[]): Promise<void>;
}

export interface BreakerStore {
  admit(functionId: string, now: number): Promise<Admission>;
  /** `opened` is true when this failure opened the breaker. */
  recordFailure(
    functionId: string,
    now: number,
    reason: string,
  ): Promise<{ opened: boolean }>;
  recordSuccess(functionId: string, now: number): Promise<void>;
  view(functionId: string, now: number): Promise<BreakerView>;
}

export interface RunnerRequest {
  runId: string;
  source: string;
  cases: TestCase[];
  caseBudgetMs: number;
  totalBudgetMs: number;
}

/** `null` = the runner did not answer in time or sent an invalid reply: "judge unavailable". */
export interface FunctionRunner {
  run(request: RunnerRequest): Promise<VerdictRecord[] | null>;
}

/** The sealed runtime as checkout sees it: a fresh isolate per call, never throws. */
export interface Sandbox {
  run(
    source: string,
    input: FunctionInput,
    timeoutMs: number,
  ): Promise<SandboxResult>;
}
export const SANDBOX = Symbol('SHOP_FUNCTIONS_SANDBOX');

export interface ShopFunctionsEntitlements {
  getMany(shopIds: string[]): Promise<Map<string, boolean>>;
  has(shopId: string): Promise<boolean>;
}

export interface JudgeRequests {
  /** In the caller's transaction (outbox `appendTask`). */
  request(functionId: string, version: number): Promise<void>;
}

export type { FunctionInput };
