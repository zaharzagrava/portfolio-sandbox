import type * as Y from 'yjs';
import type { DraftStatus } from './draft-status';
import type { DraftCursorKey } from './draft-cursor';
import type { Ability } from './frame-policy';
import type { ListingContent } from './listing-doc';

/**
 * Ports of the draft part of `catalog` (S06, constitution I and D-6): the application layer (services, rooms) depends on
 * these interfaces and their injection tokens, never on `infra/` classes or on a connection. The adapters live in
 * `infra/` and are bound by token in `drafts.module.ts` and `collab.module.ts`.
 */

// --------------------------------------------------------------------------------------------------- repositories

export interface DraftRecord {
  id: string;
  shopId: string;
  productId: string | null;
  baseProductVersion: number | null;
  title: string;
  status: DraftStatus;
  createdBy: string;
  publishLeaseId: string | null;
  publishLeaseExpiresAt: Date | null;
  publishedAt: Date | null;
  snapshotKey: string | null;
  snapshotSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDraft {
  id: string;
  shopId: string;
  productId: string | null;
  baseProductVersion: number | null;
  title: string;
  createdBy: string;
  now: Date;
}

export interface DraftTransition {
  shopId: string;
  draftId: string;
  from: DraftStatus;
  to: DraftStatus;
  /** Claim (`DRAFT -> PUBLISHING`): the new lease. Finish and release: the lease the row must still hold. */
  leaseId?: string;
  leaseExpiresAt?: Date;
  /** Finish: the product the draft became. */
  productId?: string;
  now: Date;
}

export interface DraftListRow {
  record: DraftRecord;
  key: DraftCursorKey;
}

export interface DraftRepository {
  /**
   * Inserts the draft unless the shop already has `cap` drafts in `DRAFT` or `PUBLISHING`; the count and the insert are
   * one statement under a per-shop advisory lock. `null` means the cap is reached.
   */
  insertWithinCap(input: NewDraft, cap: number): Promise<DraftRecord | null>;
  /** The draft of this shop, or `null`: another shop's id is indistinguishable from an unknown one. */
  findInShop(shopId: string, draftId: string): Promise<DraftRecord | null>;
  listByShop(
    shopId: string,
    status: DraftStatus | null,
    after: DraftCursorKey | null,
    limit: number,
  ): Promise<DraftListRow[]>;
  /** `UPDATE ... WHERE id AND shopId AND status = from [AND publishLeaseId = lease]`; `null` when no row matched. */
  transition(change: DraftTransition): Promise<DraftRecord | null>;
  /** `PUBLISHING` drafts whose lease ended before `now`, oldest first. */
  expiredLeases(
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; shopId: string; leaseId: string }>>;
  /**
   * Moves the snapshot pointer forward only. `moved` is false when the stored pointer is already at or past `seq`;
   * `previousKey` is the pointer before the move (the snapshot that is now superseded).
   */
  moveSnapshotPointer(
    shopId: string,
    draftId: string,
    key: string,
    seq: number,
  ): Promise<{ moved: boolean; previousKey: string | null }>;
  /** Points a never compacted draft at its seed snapshot (sequence 0). */
  setSeedPointer(shopId: string, draftId: string, key: string): Promise<void>;
  /** Up to `limit` ids of the shop's drafts, lowest id first (shop deletion works in batches). */
  idsOfShop(shopId: string, limit: number): Promise<string[]>;
  /** Deletes these drafts of the shop with their versions; returns how many drafts were deleted. */
  deleteByIds(shopId: string, draftIds: string[]): Promise<number>;
  /** Object keys of the versions of these drafts (so shop deletion can remove the objects). */
  versionKeysOf(shopId: string, draftIds: string[]): Promise<string[]>;
}

export interface VersionRecord {
  id: string;
  draftId: string;
  shopId: string;
  name: string;
  kind: 'named' | 'published';
  objectKey: string;
  createdBy: string;
  createdAt: Date;
}

export interface NewVersion {
  id: string;
  draftId: string;
  shopId: string;
  name: string;
  kind: 'named' | 'published';
  objectKey: string;
  createdBy: string;
  now: Date;
}

export interface VersionListRow {
  record: VersionRecord;
  key: DraftCursorKey;
}

export interface VersionRepository {
  /** Inserts a named version unless the draft already has `cap` versions (the check is in the statement). */
  insertWithinCap(
    input: NewVersion,
    cap: number,
  ): Promise<VersionRecord | null>;
  /** The `published` version written by the publish transaction (not counted against the cap). */
  insertPublished(input: NewVersion): Promise<VersionRecord>;
  findInDraft(
    shopId: string,
    draftId: string,
    versionId: string,
  ): Promise<VersionRecord | null>;
  list(
    shopId: string,
    draftId: string,
    after: DraftCursorKey | null,
    limit: number,
  ): Promise<VersionListRow[]>;
  /** Which of these object keys a version row references. */
  referencedKeys(keys: string[]): Promise<Set<string>>;
}

// -------------------------------------------------------------------------------------------- documents and objects

export interface LoadedDoc {
  doc: Y.Doc;
  /** The sequence number of the last log entry applied. */
  seq: number;
  /** Log entries read after the snapshot. */
  tailLength: number;
}

/** A log write whose sequence number already holds different bytes: another writer owns the document (split brain). */
export class SequenceConflictError extends Error {
  readonly name = 'SequenceConflictError';
  constructor(
    readonly draftId: string,
    readonly seq: number,
  ) {
    super(`sequence ${seq} of ${draftId} is held by another writer`);
  }
}

/** The store did not answer in time or refused; the caller keeps its pending updates and retries. */
export class StoreUnavailableError extends Error {
  readonly name = 'StoreUnavailableError';
  constructor(
    readonly operation: string,
    cause?: unknown,
  ) {
    super(`${operation} failed`, { cause });
  }
}

/** Durable state of a document: the latest snapshot plus the ordered update log. Usable from any process. */
export interface DocStore {
  load(shopId: string, draftId: string): Promise<LoadedDoc>;
  /**
   * Appends one merged update starting at sequence `fromSeq`, split into entries of at most 300 KB; returns the last
   * sequence written. An entry that already holds identical bytes counts as written (a retry after a lost
   * acknowledgement); different bytes throw `SequenceConflictError`.
   */
  append(draftId: string, fromSeq: number, update: Uint8Array): Promise<number>;
  /** Stores a snapshot at `seq`, moves the pointer forward only, then trims the log up to `seq`. */
  compact(
    shopId: string,
    draftId: string,
    doc: Y.Doc,
    seq: number,
  ): Promise<void>;
  /** Initial content (a draft started from a product) as the seq 0 snapshot. */
  seed(shopId: string, draftId: string, doc: Y.Doc): Promise<void>;
  /** Removes the log, the snapshots and the pointer objects of one draft (shop deletion). */
  purge(draftId: string): Promise<void>;
}

/** Objects of the draft part: `drafts/<draftId>/snap-<seq>` and `versions/<versionId>`. Every call has a timeout. */
export interface SnapshotStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Removes up to 1000 objects under the prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  list(
    prefix: string,
  ): Promise<{ key: string; lastModified: Date; size: number }[]>;
}

/** Superseded snapshot keys, kept for the daily job (deleted after the grace period). */
export interface SupersededRegistry {
  record(key: string, eligibleAt: Date): Promise<void>;
  due(now: Date, limit: number): Promise<Array<{ key: string; token: number }>>;
  remove(token: number): Promise<void>;
}

// -------------------------------------------------------------------------------------------------- routing

export interface RingMember {
  id: string;
  /** `ws(s)://host:port` clients connect to. */
  url: string;
}

export interface RingRegistry {
  /** Joins the ring and starts the heartbeat; resolves when this instance is visible to every process. */
  register(member: RingMember): Promise<void>;
  /** Leaves the ring at once (graceful shutdown). */
  leave(): Promise<void>;
  registered(): boolean;
  /** Announces this instance again at once (tests do after flushing Redis). */
  heartbeatNow(): Promise<void>;
  /** The owner of the draft in this process's current view of the ring, or `null` when the ring is empty. */
  ownerOf(draftId: string): Promise<RingMember | null>;
  members(): Promise<RingMember[]>;
  /** Reads the member list now (a process that wants the ring as it is this instant). */
  refreshNow(): Promise<void>;
  /** Called after each refresh that changed the member list. */
  onChange(handler: () => void): () => void;
}

// ------------------------------------------------------------------------------------------------- backplane

export type BackplaneMessage =
  | { type: 'revoke'; shopId: string; userId: string }
  | { type: 'recheck'; shopId: string; userId: string }
  | { type: 'close-shop'; shopId: string; reason: 'shop_inactive' }
  | { type: 'close-draft'; draftId: string; reason: 'draft_closed' };

/** Best effort instant notification between processes; the 60 second re-check carries the guarantee. */
export interface Backplane {
  publish(message: BackplaneMessage): Promise<void>;
  subscribe(handler: (message: BackplaneMessage) => void): Promise<void>;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------------------------- tenancy and tickets

export type MemberAccess =
  | { kind: 'member'; ability: Ability }
  | { kind: 'none' }
  | { kind: 'inactive'; status: 'SUSPENDED' | 'DELETING' };

/** Membership facts, always read fresh (R1). Events only decide when to ask. */
export interface MembershipReader {
  accessOf(shopId: string, userId: string): Promise<MemberAccess>;
  /** One membership read for the shop, then the ability of each listed user. */
  accessOfMany(
    shopId: string,
    userIds: string[],
  ): Promise<Map<string, MemberAccess>>;
}

/** Single use of a ticket id: `true` for the first caller within the ticket's life. */
export interface TicketIdStore {
  consume(jti: string, ttlSeconds: number): Promise<boolean>;
}

// ------------------------------------------------------------------------------------------------ owner control

/**
 * Asks the instance that owns a draft's room to freeze it (publish), release it, or persist what it has (named version).
 * `seq` is null when no room is loaded for the draft: the caller reads the stored state instead.
 */
export interface CollabControl {
  freeze(draftId: string, leaseId: string): Promise<{ seq: number | null }>;
  unfreeze(draftId: string, leaseId: string): Promise<void>;
  flush(draftId: string): Promise<{ seq: number | null }>;
}

// ---------------------------------------------------------------------------------------------- product gateway

export interface ProductSnapshotView {
  id: string;
  version: number;
  status: 'ACTIVE' | 'ARCHIVED';
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  quantity: number;
}

export interface ProductFields {
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  quantity: number;
}

/** What S06 needs from the product command service (R1); joins the ambient transaction. */
export interface ProductGateway {
  get(shopId: string, productId: string): Promise<ProductSnapshotView>;
  create(
    shopId: string,
    actorId: string,
    fields: ProductFields,
  ): Promise<ProductSnapshotView>;
  /** `unchanged` is true when nothing differed (the product kept its version). */
  update(
    shopId: string,
    productId: string,
    actorId: string,
    expectedVersion: number,
    changes: Partial<ProductFields>,
  ): Promise<{ product: ProductSnapshotView; unchanged: boolean }>;
}

// --------------------------------------------------------------------------------------------- injection tokens

export const DRAFT_REPOSITORY = Symbol('DRAFT_REPOSITORY');
export const VERSION_REPOSITORY = Symbol('VERSION_REPOSITORY');
export const DOC_STORE = Symbol('DOC_STORE');
export const SNAPSHOT_STORE = Symbol('SNAPSHOT_STORE');
export const SUPERSEDED_REGISTRY = Symbol('SUPERSEDED_REGISTRY');
export const RING_REGISTRY = Symbol('RING_REGISTRY');
export const COLLAB_BACKPLANE = Symbol('COLLAB_BACKPLANE');
export const DRAFT_MEMBERSHIP = Symbol('DRAFT_MEMBERSHIP');
export const TICKET_ID_STORE = Symbol('TICKET_ID_STORE');
export const PRODUCT_GATEWAY = Symbol('PRODUCT_GATEWAY');
export const COLLAB_CONTROL = Symbol('COLLAB_CONTROL');

/** The publish-time reading of a document: the content the product is built from. */
export type PublishContent = ListingContent;
