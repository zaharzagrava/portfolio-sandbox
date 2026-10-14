import type { ApiScope } from './api-key-format';

/**
 * Ports of the public API capability (G-45, D-6): controllers and services depend on these, never on Sequelize, Redis,
 * ClickHouse or another domain's service directly. Adapters live in `infra/`.
 */

// ---------------------------------------------------------------- keys

export interface ApiKeyRecord {
  id: string;
  /** The live shop that owns the key (a test key acts on its sandbox, resolved at first use). */
  shopId: string;
  prefix: string;
  hash: string;
  /** 1 = hashed with the current pepper, 0 = with the previous one (re-hash on use). */
  hashVersion: number;
  name: string;
  scopes: ApiScope[];
  livemode: boolean;
  createdBy: string;
  expiresAt: Date | null;
  successorId: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface NewApiKey {
  shopId: string;
  createdBy: string;
  name: string;
  scopes: ApiScope[];
  livemode: boolean;
  expiresAt: Date | null;
  prefix: string;
  hash: string;
}

export type CreateKeyOutcome =
  | { outcome: 'created'; record: ApiKeyRecord; pinnedVersion: string }
  | { outcome: 'limit_reached' }
  | { outcome: 'prefix_taken' };

export type RotateKeyOutcome =
  | { outcome: 'rotated'; old: ApiKeyRecord; successor: ApiKeyRecord }
  | { outcome: 'not_found' }
  | { outcome: 'illegal'; current: ApiKeyRecord }
  | { outcome: 'prefix_taken' };

export type RevokeReason = 'manual' | 'shop_deleted' | 'rotation_expired';

export abstract class ApiKeyRepository {
  abstract prefixExists(prefix: string): Promise<boolean>;
  /**
   * One transaction: pins the shop's version if it has none (and serialises the shop's creators on that row), counts the
   * keys that are active or rotating (a rotating pair counts once) against `limit`, inserts, and appends
   * `api_key_created` (and `api_version_pinned` when this call pinned).
   */
  abstract createWithLimit(input: {
    key: NewApiKey;
    now: Date;
    limit: number;
    latestVersion: string;
  }): Promise<CreateKeyOutcome>;
  /**
   * One transaction: inserts the successor, then moves the old key to `rotating` with a conditional update (active only;
   * one winner among concurrent callers) and appends `api_key_rotated`.
   */
  abstract rotate(input: {
    shopId: string;
    keyId: string;
    successor: NewApiKey;
    overlapHours: number;
    now: Date;
    actorId: string;
  }): Promise<RotateKeyOutcome>;
  /** Conditional, idempotent; the event is appended only by the call that made the transition. */
  abstract revoke(input: {
    shopId: string;
    keyId: string;
    now: Date;
    actorId: string | null;
    reason: RevokeReason;
  }): Promise<
    | { outcome: 'revoked'; record: ApiKeyRecord }
    | { outcome: 'already_revoked'; record: ApiKeyRecord }
    | { outcome: 'not_found' }
  >;
  /** Revokes every key of the shop that is not revoked yet, one event each; returns the keys it changed. */
  abstract revokeAllForShop(
    shopId: string,
    now: Date,
    reason: RevokeReason,
  ): Promise<ApiKeyRecord[]>;
  abstract findForShop(
    shopId: string,
    keyId: string,
  ): Promise<ApiKeyRecord | null>;
  abstract findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  /** Keyset page, newest first with the id as tiebreaker, strictly after `after`. */
  abstract list(
    shopId: string,
    limit: number,
    after: { createdAt: string; id: string } | null,
  ): Promise<ApiKeyRecord[]>;
  /** Monotonic: never moves `lastUsedAt` backwards; returns how many rows changed. */
  abstract touchLastUsed(entries: { id: string; at: Date }[]): Promise<number>;
  /** Stores the hash under the current pepper (version 1) for a key verified with the previous one. */
  abstract rehash(id: string, hash: string): Promise<void>;
}

// ---------------------------------------------------------------- key cache

/** What the fast store holds about a key: the hash and metadata, never "this secret is valid" (FR-008). */
export interface CachedKey {
  id: string;
  /** The live shop that owns the key. */
  shopId: string;
  /** The shop the key acts on: `shopId` for a live key, its sandbox shop for a test key (resolved when the entry is filled). */
  actingShopId: string;
  createdBy: string;
  hash: string;
  hashVersion: number;
  scopes: ApiScope[];
  livemode: boolean;
  expiresAt: number | null;
  revoked: boolean;
}

export abstract class KeyCache {
  /** One round trip for the entry and the revoke tombstone. */
  abstract get(
    prefix: string,
  ): Promise<{ entry: CachedKey | 'none' | null; tombstone: boolean }>;
  /** Stores only if no entry exists (a slow filler never overwrites a newer state). */
  abstract fillIfAbsent(
    prefix: string,
    entry: CachedKey | 'none',
    ttlSec: number,
  ): Promise<void>;
  /** Marks the key revoked for longer than any entry can live, then drops the entry. */
  abstract tombstone(prefix: string): Promise<void>;
  abstract invalidate(prefix: string): Promise<void>;
  /** Records a use; the loss of the record only leaves `lastUsedAt` older. */
  abstract touch(id: string, at: Date): Promise<void>;
  /** Atomically takes every recorded use (highest instant per key). */
  abstract drainUses(): Promise<{ id: string; at: Date }[]>;
  /** Gives drained uses back after a failed flush (never lowers a newer record). */
  abstract restoreUses(uses: { id: string; at: Date }[]): Promise<void>;
}

// ---------------------------------------------------------------- settings (version pin)

export abstract class SettingsRepository {
  /** `null` for a shop that has none. */
  abstract getPinned(
    shopId: string,
  ): Promise<{ version: string; pinnedAt: Date | null } | null>;
  /** At most 500 shops, one statement; shops without a pin are absent. */
  abstract getPinnedMany(shopIds: string[]): Promise<Map<string, string>>;
  /** Pins `version` only if the shop has none; returns the pin the shop has afterwards. */
  abstract pinIfAbsent(
    shopId: string,
    version: string,
    now: Date,
  ): Promise<string>;
  /** Changes the pin (pinning first if there is none); appends `api_version_pinned`. */
  abstract change(input: {
    shopId: string;
    version: string;
    now: Date;
    actorId: string;
  }): Promise<{ previousVersion: string | null; pinnedAt: Date }>;
}

/** The pin as the serving path reads it: a 5 s entry in the fast store, dropped at once by a change. */
export abstract class VersionPinCache {
  abstract get(shopId: string): Promise<string | null>;
  abstract put(shopId: string, version: string, ttlSec: number): Promise<void>;
  abstract invalidate(shopId: string): Promise<void>;
}

/**
 * The schema of a route applied to a batch operation's body: the same validation the route's pipe does, so a batched
 * operation can never carry what the route would refuse (FR-043). Implemented in the API layer.
 */
export abstract class OperationValidator {
  abstract createProduct(plain: Record<string, unknown>): Promise<{
    title: string;
    description?: string;
    price: { amount: number; currency: string };
    stock?: number;
    category: string;
    brand: string;
  }>;
  abstract updateProduct(plain: Record<string, unknown>): Promise<{
    title?: string;
    description?: string;
    price?: { amount: number; currency: string };
    stock?: number;
    category?: string;
    brand?: string;
  }>;
}

// ---------------------------------------------------------------- request records

/** One authenticated call, as produced (contracts/events.md `api.request_logged` v1). Never a path id, query, header or body. */
export interface RequestRecord {
  requestId: string;
  clientRequestId?: string;
  /** The live shop for both key modes. */
  shopId: string;
  keyId: string;
  livemode: boolean;
  version: string;
  method: string;
  /** The route template, e.g. `/v1/products/:id`. */
  route: string;
  status: number;
  durationMs: number;
  deprecated: boolean;
  errorCode?: string;
  batchOps?: number;
  idempotentReplay: boolean;
  cost: number;
  /** When the call finished, from the injected clock. */
  occurredAt: Date;
}

/** Hands records to the event bus (edge: the Kafka producer). Rejects when the bus does not take them. */
export abstract class RequestRecordPublisher {
  abstract publish(records: RequestRecord[]): Promise<void>;
}

/** A stored request record as the dashboard reads it. */
export interface StoredRequest {
  requestId: string;
  clientRequestId: string;
  shopId: string;
  keyId: string;
  livemode: boolean;
  version: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  deprecated: boolean;
  errorCode: string;
  batchOps: number;
  idempotentReplay: boolean;
  /** ISO instant. */
  at: string;
}

export interface RequestSearch {
  requestId?: string;
  status?: { min: number; max: number };
  route?: string;
  keyId?: string;
  livemode?: boolean;
  from: Date;
  to: Date;
}

export interface UsageQuery {
  from: Date;
  livemode: boolean;
  deprecatedOnly: boolean;
}

/** The request log (30 days): written once per `(shop, request id)`, read only with the shop in the predicate. */
export abstract class RequestLogStore {
  abstract insertNew(
    records: (Omit<StoredRequest, 'at'> & { at: Date })[],
  ): Promise<number>;
  abstract search(
    shopId: string,
    filter: RequestSearch,
    limit: number,
    after: { at: string; requestId: string } | null,
  ): Promise<StoredRequest[]>;
  abstract usageByDay(
    shopId: string,
    q: UsageQuery,
  ): Promise<
    {
      day: string;
      version: string;
      route: string;
      calls: number;
      errors: number;
      deprecatedCalls: number;
    }[]
  >;
  abstract usageByKey(
    shopId: string,
    q: UsageQuery,
  ): Promise<
    {
      keyId: string;
      version: string;
      route: string;
      calls: number;
      errors: number;
      lastCallAt: string;
    }[]
  >;
}

/** Billable usage per shop and UTC minute (FR-058): exact, deduplicated, emitted once per `(shop, minute, sequence)`. */
export abstract class UsageBucketRepository {
  /**
   * In one transaction: records `eventId` as handled (a duplicate adds nothing), then adds `quantity` to the shop's open
   * bucket of that minute, or opens a new one with the next sequence when the minute was already emitted.
   */
  abstract add(input: {
    eventId: string;
    shopId: string;
    minute: Date;
    quantity: number;
  }): Promise<'added' | 'duplicate'>;
  /**
   * Emits `usage.recorded` for open buckets whose minute closed before `closedBefore`, at most `limit`, each marked
   * emitted in the transaction that writes its event. Returns how many.
   */
  abstract emitClosed(input: {
    closedBefore: Date;
    limit: number;
    now: Date;
  }): Promise<number>;
}

// ---------------------------------------------------------------- monthly plan quota

export interface QuotaAnswer {
  allowed: boolean;
  used: number;
  limit: number;
  /** When the month's allowance renews (ISO instant). */
  resetsAt: string;
}

/** The billing capability cannot answer (`usage_unavailable`, or it exports no quota check yet): the call is served. */
export class QuotaUnavailable extends Error {
  constructor(readonly reason: 'usage_unavailable' | 'not_available') {
    super(`quota unavailable: ${reason}`);
    this.name = 'QuotaUnavailable';
  }
}

/** The plan quota of a shop's API calls (FR-053), answered by the billing capability's `checkQuota`. */
export abstract class QuotaPort {
  /** Rejects with `QuotaUnavailable` when no answer can be given. */
  abstract check(shopId: string): Promise<QuotaAnswer>;
}

/** The answer cached per shop for 60 s, so a plan upgrade is seen within a minute. */
export abstract class QuotaCache {
  abstract get(shopId: string): Promise<QuotaAnswer | null>;
  abstract put(
    shopId: string,
    answer: QuotaAnswer,
    ttlSec: number,
  ): Promise<void>;
}

// ---------------------------------------------------------------- bulk stock jobs

export interface BulkFailure {
  operation_id: string;
  product_id: string;
  outcome: string;
}

export interface BulkJobRecord {
  id: string;
  shopId: string;
  total: number;
  chunks: number;
  completedChunks: number;
  applied: number;
  replayed: number;
  failed: number;
  failures: BulkFailure[];
  status: 'processing' | 'succeeded' | 'partially_failed' | 'failed';
  createdAt: Date;
  expiresAt: Date;
}

export interface BulkChunkMessageBody {
  jobId: string;
  shopId: string;
  index: number;
  items: { operationId: string; productId: string; delta: number }[];
}

/** The durable state of bulk jobs (FR-047): never the cache, counters change only in the transaction that flips a chunk marker. */
export abstract class BulkJobRepository {
  /**
   * One transaction: the job, one pending marker per chunk and one queue task per chunk on the outbox (the queue
   * options are validated where the task is created, so a bad option fails here, not in the relay — L-001).
   */
  abstract create(input: {
    id: string;
    shopId: string;
    total: number;
    messages: BulkChunkMessageBody[];
    now: Date;
  }): Promise<void>;
  abstract find(shopId: string, id: string): Promise<BulkJobRecord | null>;
  abstract chunkState(
    jobId: string,
    index: number,
  ): Promise<'pending' | 'done' | 'failed' | null>;
  /**
   * Flips the chunk's marker and adds its counts to the job in one transaction. `duplicate` when the marker was
   * already flipped: nothing is counted twice, however often the chunk is delivered.
   */
  abstract completeChunk(input: {
    jobId: string;
    shopId: string;
    index: number;
    totals: {
      applied: number;
      replayed: number;
      failed: number;
      failures: BulkFailure[];
    };
    now: Date;
  }): Promise<'recorded' | 'duplicate'>;
  /** Deletes jobs past `expiresAt` with their chunks, at most `batch` jobs per statement. */
  abstract purgeExpired(now: Date, batch: number): Promise<number>;
}

// ---------------------------------------------------------------- tenancy (R1 adapter)

export interface ShopFacts {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  isSandbox: boolean;
}

/** The shop's lifecycle status, cached for at most 60 s and dropped at once by `tenancy.shop_status_changed` (FR-017). */
export abstract class ShopStatusCache {
  abstract get(shopId: string): Promise<ShopFacts['status'] | null>;
  abstract put(
    shopId: string,
    status: ShopFacts['status'],
    ttlSec: number,
  ): Promise<void>;
  abstract invalidate(shopId: string): Promise<void>;
}

export abstract class ShopDirectory {
  /** The shop a test key acts on, created idempotently at first use. */
  abstract sandboxShopOf(liveShopId: string): Promise<string>;
  abstract getShops(ids: string[]): Promise<Map<string, ShopFacts>>;
}
