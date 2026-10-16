import type { Readable } from 'node:stream';

/**
 * Ports of the asset library (D-6): the application services depend on these; the Sequelize and storage adapters live in
 * `infra/`. Times are always passed in (platform clock, FR-049). Methods that say "lock" must run inside a
 * `TransactionRunner.run` scope; none of them calls storage.
 */

export type AssetStatus = 'ACTIVE' | 'DELETED' | 'PURGED';

export interface AssetRecord {
  id: string;
  shopId: string;
  path: string;
  status: AssetStatus;
  currentVersion: number;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface AssetListRow extends AssetRecord {
  sizeBytes: number;
}

export interface VersionRecord {
  assetId: string;
  version: number;
  sizeBytes: number;
  chunks: string[];
  createdBy: string | null;
  deviceId: string | null;
  createdAt: Date;
}

export interface VersionSummary {
  version: number;
  sizeBytes: number;
  chunkCount: number;
  createdBy: string | null;
  deviceId: string | null;
  createdAt: Date;
}

export interface ChunkRecord {
  hash: string;
  size: number;
  refCount: number;
  storedAt: Date | null;
  protectedUntil: Date | null;
  deleting: boolean;
  reserved: boolean;
  unreferencedSince: Date | null;
}

export interface ChunkDeltaInput {
  hash: string;
  delta: number;
}

export interface ChunkOccurrenceInput {
  hash: string;
  occurrences: number;
}

export interface JournalEntry {
  seq: number;
  assetId: string;
  path: string;
  version: number;
  kind: 'upsert' | 'delete';
}

export interface AssetRepository {
  /** `FOR UPDATE` on the live asset at a path. */
  lockActiveByPath(shopId: string, path: string): Promise<AssetRecord | null>;
  /** Inserts a live asset; `false` when another live asset holds the path (nothing is written). */
  insertActive(input: {
    id: string;
    shopId: string;
    path: string;
    now: Date;
  }): Promise<boolean>;
  /** The asset in this shop, any status; the shop is part of the predicate. */
  find(shopId: string, assetId: string): Promise<AssetRecord | null>;
  lock(shopId: string, assetId: string): Promise<AssetRecord | null>;
  setCurrentVersion(assetId: string, version: number, now: Date): Promise<void>;
  /** A conditional transition (III.7): `true` only if the asset was in `from`. */
  transition(input: {
    shopId: string;
    assetId: string;
    from: AssetStatus;
    to: AssetStatus;
    deletedAt: Date | null;
    now: Date;
  }): Promise<boolean>;
  /** Deletes every asset row of a shop (the shop was deleted). */
  removeAllOfShop(shopId: string): Promise<void>;
  /** Removes the share links and download grants of an asset (purge removes them explicitly, FR-029). */
  removeShareArtifacts(assetId: string): Promise<void>;
  /** True while the asset is linked to a digital product or referenced by an entitlement (`asset_in_use`). */
  inUse(assetId: string): Promise<boolean>;
  /** Live paths that start with `prefix` (literal). */
  activePathsStartingWith(shopId: string, prefix: string): Promise<Set<string>>;
  listPage(input: {
    shopId: string;
    prefix: string | null;
    deleted: boolean;
    deletedSince: Date;
    limit: number;
    after: { path: string; id: string } | null;
  }): Promise<AssetListRow[]>;
  /** Deleted assets past the cutoff, locked and skipped when another run holds them. */
  lockDeletedBefore(cutoff: Date, limit: number): Promise<AssetRecord[]>;
  /** Every asset of a shop that is not purged, locked, `limit` at a time. */
  lockUnpurgedOfShop(shopId: string, limit: number): Promise<AssetRecord[]>;
}

export interface VersionRepository {
  insert(input: {
    assetId: string;
    shopId: string;
    version: number;
    sizeBytes: number;
    chunks: string[];
    occurrences: ChunkOccurrenceInput[];
    createdBy: string;
    deviceId: string;
    now: Date;
  }): Promise<void>;
  find(assetId: string, version: number): Promise<VersionRecord | null>;
  count(assetId: string): Promise<number>;
  /** Newest first; `before` is the last version of the previous page. */
  page(
    assetId: string,
    limit: number,
    before: number | null,
  ): Promise<VersionSummary[]>;
  /** Removes a version and its chunk rows; returns what was removed, `null` when it did not exist. */
  remove(assetId: string, version: number): Promise<VersionRecord | null>;
  /** Removes every version of an asset; returns them (for the exact release of references). */
  removeAll(assetId: string): Promise<VersionRecord[]>;
}

export interface ChunkRepository {
  findMany(shopId: string, hashes: string[]): Promise<ChunkRecord[]>;
  /** `FOR UPDATE`, ordered by hash so concurrent writers lock in one order. */
  lockMany(shopId: string, hashes: string[]): Promise<ChunkRecord[]>;
  /** Placeholder rows for chunks nobody holds yet; returns the rows actually inserted. */
  insertPlaceholders(input: {
    shopId: string;
    chunks: { hash: string; size: number }[];
    now: Date;
    protectedUntil: Date;
  }): Promise<{ hash: string; size: number }[]>;
  /** Records that storage holds the chunks; returns the bytes newly stored and how many of them were reserved. */
  confirmStored(
    shopId: string,
    hashes: string[],
    now: Date,
    protectedUntil: Date,
  ): Promise<{ storedBytes: number; fromReservedBytes: number }>;
  /** Back to "reserved, not stored" (the object vanished; unreferenced chunks only). Returns the bytes that moved. */
  markNotStored(
    shopId: string,
    hashes: string[],
    protectedUntil: Date,
  ): Promise<number>;
  /** Restarts the protection of chunks reported stored (FR-004). */
  protect(
    shopId: string,
    hashes: string[],
    protectedUntil: Date,
  ): Promise<void>;
  /** Changes reference counts by `delta` (never below zero) and returns the counts after. */
  adjust(input: {
    shopId: string;
    deltas: ChunkDeltaInput[];
    now: Date;
    protectedUntil: Date;
  }): Promise<{ hash: string; refCount: number }[]>;
  /** Claims unreferenced, unprotected chunks for deletion (`deleting = true`), skipping rows other runs hold. */
  claimForCleanup(input: {
    unreferencedBefore: Date;
    protectedBefore: Date;
    limit: number;
  }): Promise<(ChunkRecord & { shopId: string })[]>;
  /** Releases a claim whose object delete failed. */
  releaseClaim(shopId: string, hash: string): Promise<void>;
  /** Deletes the row of a claimed chunk (only while still claimed and unreferenced); returns it. */
  deleteClaimed(
    shopId: string,
    hash: string,
  ): Promise<(ChunkRecord & { shopId: string }) | null>;
  /** Every chunk row of a shop (for the shop purge), claimed in batches. */
  claimAllOfShop(
    shopId: string,
    limit: number,
  ): Promise<(ChunkRecord & { shopId: string })[]>;
}

export interface UsageRepository {
  ensure(shopId: string): Promise<void>;
  /** `true` when `bytes` fit the quota and were reserved (one conditional update). */
  reserve(shopId: string, bytes: number, quotaBytes: number): Promise<boolean>;
  used(shopId: string): Promise<{ storedBytes: number; reservedBytes: number }>;
  /** Signed deltas; the table refuses a negative total. */
  adjust(
    shopId: string,
    delta: { storedBytes: number; reservedBytes: number },
  ): Promise<void>;
  remove(shopId: string): Promise<void>;
  /** Bytes per shop size tier (bounded labels for the storage gauge). */
  tiers(): Promise<
    {
      tier: 'small' | 'medium' | 'large';
      storedBytes: number;
      reservedBytes: number;
    }[]
  >;
}

export interface JournalRepository {
  /** Takes the shop's counter row (`FOR UPDATE`) and returns the next number; hold to the end of the transaction. */
  nextSeq(shopId: string): Promise<number>;
  append(input: {
    shopId: string;
    seq: number;
    assetId: string;
    path: string;
    version: number;
    kind: 'upsert' | 'delete';
    now: Date;
  }): Promise<void>;
  lastSeq(shopId: string): Promise<number>;
  minSeq(shopId: string): Promise<number>;
  after(shopId: string, seq: number, limit: number): Promise<JournalEntry[]>;
  /** Removes entries older than `cutoff` and records the floor; returns the number removed. */
  purgeOlderThan(cutoff: Date): Promise<number>;
  removeShop(shopId: string): Promise<void>;
}

/** Object storage for chunks. Keys are derived here from shop and hash, never from client input (FR-002). */
export abstract class ChunkStore {
  abstract presignPut(
    shopId: string,
    hash: string,
    size: number,
    expiresInSec: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  abstract presignGet(
    shopId: string,
    hash: string,
    expiresInSec: number,
  ): Promise<string>;
  /** Throws `StorageUnavailableError` when storage fails or times out. */
  abstract exists(shopId: string, hash: string): Promise<boolean>;
  /** Opens the chunk for reading; throws `StorageUnavailableError` on failure or timeout. */
  abstract open(shopId: string, hash: string): Promise<Readable>;
  abstract remove(shopId: string, hash: string): Promise<void>;
}

export class StorageUnavailableError extends Error {
  readonly name = 'StorageUnavailableError';
  constructor(operation: string) {
    super(`storage ${operation} failed`);
  }
}

export interface ShareLinkRecord {
  id: string;
  shopId: string;
  assetId: string;
  expiresAt: Date;
  maxDownloads: number | null;
  downloads: number;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** A share link joined with its asset, as preview and redeem need it. */
export interface ShareTarget extends ShareLinkRecord {
  assetStatus: AssetStatus;
  path: string;
  currentVersion: number;
}

export interface GrantRecord {
  tokenHash: string;
  kind: 'share' | 'purchase';
  shopId: string;
  assetId: string;
  version: number;
  shareLinkId: string | null;
  entitlementId: string | null;
  buyerId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** A grant joined with what decides whether it still works. */
export interface ResolvedGrant extends GrantRecord {
  assetStatus: AssetStatus;
  path: string;
  linkRevokedAt: Date | null;
  linkFound: boolean;
  entitlementStatus: 'ACTIVE' | 'REVOKED' | null;
}

export interface ShareRepository {
  insert(input: {
    id: string;
    shopId: string;
    assetId: string;
    tokenHash: string;
    createdBy: string;
    expiresAt: Date;
    maxDownloads: number | null;
    now: Date;
  }): Promise<void>;
  listOfAsset(shopId: string, assetId: string): Promise<ShareLinkRecord[]>;
  findOfAsset(
    shopId: string,
    assetId: string,
    linkId: string,
  ): Promise<ShareLinkRecord | null>;
  /** `true` only if the link was not revoked yet. */
  revoke(linkId: string, now: Date): Promise<boolean>;
  findByTokenHash(tokenHash: string): Promise<ShareTarget | null>;
  /**
   * The atomic redeem (FR-034): expiry, revocation, cap and the live asset are checked and the counter incremented in
   * one conditional update. `null` when any condition fails; nothing changes then.
   */
  redeem(tokenHash: string, now: Date): Promise<ShareTarget | null>;
}

export interface GrantRepository {
  insert(grant: GrantRecord): Promise<void>;
  resolve(tokenHash: string): Promise<ResolvedGrant | null>;
  purgeExpired(cutoff: Date): Promise<number>;
}

export interface DigitalLinkRecord {
  productId: string;
  shopId: string;
  assetId: string;
  linkedAt: Date;
}

export interface DigitalLinkView {
  productId: string;
  assetId: string;
  path: string;
  sizeBytes: number;
  version: number;
  linkedAt: Date;
}

export interface EntitlementRecord {
  id: string;
  orderId: string;
  productId: string;
  shopId: string;
  buyerId: string;
  assetId: string;
  title: string;
  status: 'ACTIVE' | 'REVOKED';
  grantedAt: Date;
}

export interface NewEntitlement {
  id: string;
  productId: string;
  shopId: string;
  assetId: string;
  title: string;
}

export interface PurchaseRow {
  entitlementId: string;
  productId: string;
  shopId: string;
  orderId: string;
  title: string;
  path: string;
  sizeBytes: number;
  grantedAt: Date;
}

/** The buyer's active entitlement joined with the asset it delivers. */
export interface ActiveEntitlement extends EntitlementRecord {
  assetStatus: AssetStatus;
  currentVersion: number;
}

export interface DigitalRepository {
  lockLink(productId: string): Promise<DigitalLinkRecord | null>;
  upsertLink(input: {
    productId: string;
    shopId: string;
    assetId: string;
    now: Date;
  }): Promise<void>;
  deleteLink(productId: string): Promise<void>;
  view(shopId: string, productId: string): Promise<DigitalLinkView | null>;
  /** The links of these products (any shop); the caller compares the shop of each line. */
  linksFor(productIds: string[]): Promise<DigitalLinkRecord[]>;
  /** Removes every link of a shop; returns them. */
  removeOfShop(shopId: string): Promise<DigitalLinkRecord[]>;
}

export interface EntitlementRepository {
  /** Serializes the paid and refunded handling of one order (an advisory lock held to the end of the transaction). */
  lockOrder(orderId: string): Promise<void>;
  hasRevocation(orderId: string): Promise<boolean>;
  recordRevocation(input: {
    orderId: string;
    orderVersion: number;
    now: Date;
  }): Promise<void>;
  /** One row per `(orderId, productId)`; returns only the rows actually created. */
  insertMany(input: {
    orderId: string;
    buyerId: string;
    entitlements: NewEntitlement[];
    now: Date;
  }): Promise<EntitlementRecord[]>;
  revokeOfOrder(
    orderId: string,
    reason: 'refunded' | 'shop_deleted',
    now: Date,
  ): Promise<EntitlementRecord[]>;
  revokeOfShop(
    shopId: string,
    reason: 'refunded' | 'shop_deleted',
    now: Date,
  ): Promise<EntitlementRecord[]>;
  anyOfProduct(productId: string): Promise<boolean>;
  moveToAsset(productId: string, assetId: string): Promise<number>;
  purchases(input: {
    buyerId: string;
    limit: number;
    after: { at: Date; id: string } | null;
  }): Promise<PurchaseRow[]>;
  findActive(
    buyerId: string,
    productId: string,
  ): Promise<ActiveEntitlement | null>;
  /** Counts a download; `false` if the entitlement is no longer active. */
  recordDownload(entitlementId: string, now: Date): Promise<boolean>;
}

export const DIGITAL = Symbol('DIGITAL');
export const ENTITLEMENTS = Symbol('ENTITLEMENTS');
export const SHARES = Symbol('SHARES');
export const GRANTS = Symbol('GRANTS');
export const ASSETS = Symbol('ASSETS');
export const VERSIONS = Symbol('VERSIONS');
export const CHUNKS = Symbol('CHUNKS');
export const USAGE = Symbol('USAGE');
export const JOURNAL = Symbol('JOURNAL');
