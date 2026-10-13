import type { BoardSort, TopWindow } from '@marketplace-sandbox/contracts';
import type { VoteCounts, VoteRecord } from './vote-transition';

/**
 * Ports of the discussions application layer (S25 G6, D-6): `application/` depends on these interfaces and their
 * tokens only; `infra/` binds them to ScyllaDB, Redis, the identity directory and the catalog (constitution I.1-I.3).
 */

/** The fast derived state is unavailable (down, timed out). Callers choose: degrade a read, refuse a vote. */
export class CacheUnavailableError extends Error {
  constructor() {
    super('cache_unavailable');
  }
}

export type DeletedBy = 'author' | 'moderator';
export type TargetType = 'post' | 'comment';

export interface PostRow {
  postId: string;
  boardId: string;
  authorId: string;
  title: string;
  /** Raw markdown; `null` once the post is deleted (erased). */
  bodyMd: string | null;
  bodyHtml: string | null;
  /** Policy version that produced `bodyHtml`; `null` for rows written before versions existed. */
  htmlVersion: number | null;
  createdAt: Date;
  deleted: boolean;
  deletedBy: DeletedBy | null;
  shadow: boolean;
}

export interface CommentRow {
  commentId: string;
  postId: string;
  bucket: number;
  path: string;
  parentId: string | null;
  depth: number;
  /** `null` once the comment is a tombstone. */
  authorId: string | null;
  bodyMd: string | null;
  bodyHtml: string | null;
  htmlVersion: number | null;
  createdAt: Date;
  deleted: boolean;
  deletedBy: DeletedBy | null;
  shadow: boolean;
  /** Root rows only: the root has more descendants than the embedded first page. */
  moreReplies: boolean;
}

export interface CommentLocator {
  commentId: string;
  postId: string;
  bucket: number;
  path: string;
  depth: number;
  authorId: string | null;
  parentId: string | null;
}

/** An event written in the same logged batch as the state change that caused it (R-3). */
export interface RecordedEvent {
  eventId: string;
  type: string;
  version: number;
  aggregateId: string;
  occurredAt: Date;
  /** The full event envelope as JSON. */
  envelope: string;
}

export interface BoardListEntry {
  postId: string;
  authorId: string | null;
  shadow: boolean;
  deleted: boolean;
}

export interface PostStore {
  /** One logged batch: `posts`, `posts_by_board`, `board_months` and the event rows (idempotent upserts). */
  insert(row: PostRow, event: RecordedEvent | null): Promise<void>;
  get(postId: string): Promise<PostRow | null>;
  /** One `IN` query; unknown ids are absent. */
  getMany(postIds: string[]): Promise<PostRow[]>;
  /** Marks the post deleted exactly once; `true` only for the caller that applied it (it then records the event). */
  tombstone(
    row: PostRow,
    by: DeletedBy,
    event: RecordedEvent | null,
  ): Promise<boolean>;
  setRendition(postId: string, html: string, version: number): Promise<void>;
  /** Months (`yyyymm`) of a board with posts, newest first, starting at `fromBucket` (inclusive). */
  months(
    boardId: string,
    fromBucket: number | null,
    limit: number,
  ): Promise<number[]>;
  /** Posts of one month, newest first, strictly older than `beforePostId` when given. */
  monthPage(
    boardId: string,
    bucket: number,
    beforePostId: string | null,
    limit: number,
  ): Promise<BoardListEntry[]>;
}

export interface ThreadRoot {
  bucket: number;
  path: string;
  commentId: string;
  shadow: boolean;
  deleted: boolean;
  authorId: string | null;
}

export interface CommentStore {
  /** Takes the next top-level slot of a post (compare-and-set); returns its partition bucket. */
  allocateRootBucket(postId: string, partitionSize: number): Promise<number>;
  /** One logged batch: comment row, root index row, locator, worklist row and the event rows. */
  insert(
    row: CommentRow,
    authorId: string,
    event: RecordedEvent | null,
    day: number,
  ): Promise<void>;
  getLocator(commentId: string): Promise<CommentLocator | null>;
  getRow(
    postId: string,
    bucket: number,
    path: string,
  ): Promise<CommentRow | null>;
  /** Roots of a post in thread order. `after` is the last position already returned. */
  roots(
    postId: string,
    direction: 'asc' | 'desc',
    after: { bucket: number; path: string } | null,
    limit: number,
  ): Promise<ThreadRoot[]>;
  /**
   * A root and its descendants in thread order (parents before children): rows with `path >= from`, within the
   * subtree of `rootPath`. `inclusiveFrom: false` starts after `from`.
   */
  subtree(
    postId: string,
    bucket: number,
    rootPath: string,
    from: string,
    inclusiveFrom: boolean,
    limit: number,
  ): Promise<CommentRow[]>;
  /** Marks a comment (and its root index row) deleted exactly once; `true` for the caller that applied it. */
  tombstone(
    row: CommentRow,
    by: DeletedBy,
    event: RecordedEvent | null,
  ): Promise<boolean>;
  markMoreReplies(
    postId: string,
    bucket: number,
    rootPath: string,
  ): Promise<void>;
  /** Exact visible-comment counts straight from the rows (reconciliation): total and direct replies per parent. */
  scanCounts(
    postId: string,
  ): Promise<{ visible: number; replies: Map<string, number> }>;
  setRendition(
    row: Pick<CommentRow, 'postId' | 'bucket' | 'path'>,
    html: string,
    version: number,
  ): Promise<void>;
}

export interface VoteState extends VoteRecord {
  /** `null` on rows written before versions existed. */
  version: number | null;
  /** The compare-and-set token with `version`: a retraction restarts versions, the cast time does not repeat. */
  castAt: Date | null;
}

export interface VoteStore {
  get(targetId: string, userId: string): Promise<VoteState | null>;
  /**
   * Compare-and-set of one user's record: `expected` is what the caller read (`null` = no record). `next` `null`
   * deletes. Returns whether it applied.
   */
  cas(
    targetId: string,
    userId: string,
    targetType: TargetType,
    expected: VoteState | null,
    next: VoteRecord | null,
    castAt: Date,
  ): Promise<boolean>;
  /** Exact counts from the records (paged read of the target's partition). */
  recount(targetId: string): Promise<VoteCounts>;
  /** The viewer's own votes among `targetIds`. */
  viewerVotes(
    targetIds: string[],
    userId: string,
  ): Promise<Map<string, 1 | -1>>;
}

export interface ClaimResult {
  claimed: boolean;
  /** The entity and note of the first claim when this one lost. */
  entityId: string;
  note: string;
}

/** How long an `Idempotency-Key` identifies one request (the platform record's TTL, V.6). */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;

export interface ClaimStore {
  /**
   * `INSERT ... IF NOT EXISTS USING TTL`: the first caller of (user, key) owns `entityId`. A claim older than the
   * idempotency window is stale (the platform record is gone too), so the key starts a new request and takes it over.
   */
  claim(
    userId: string,
    keyHash: string,
    kind: 'post' | 'comment',
    entityId: string,
    note: string,
    createdAt: Date,
  ): Promise<ClaimResult>;
}

export interface PendingEvent {
  hourShard: string;
  eventId: string;
  type: string;
  aggregateId: string;
  occurredAt: Date;
  envelope: string;
}

export interface EventStore {
  /** Records one event outside a content batch (anomaly signal): same rows as the batched path. */
  record(event: RecordedEvent): Promise<void>;
  pending(hourShards: string[], limit: number): Promise<PendingEvent[]>;
  delivered(event: PendingEvent): Promise<void>;
  deadLetter(event: PendingEvent, reason: string, day: number): Promise<void>;
}

/** One-shot expand step for data written before S25 (idempotent upserts, resumable by page state). */
export interface BackfillStore {
  /** Inserts `board_months` rows for one page of old `posts`; returns the next page state or `null` when done. */
  boardMonths(
    pageState: string | null,
    size: number,
  ): Promise<{ rows: number; next: string | null }>;
  /** Inserts `top_comments_by_post` and `post_buckets` rows for one page of old `comments_by_post`. */
  threadRoots(
    pageState: string | null,
    size: number,
    partitionSize: number,
  ): Promise<{ rows: number; next: string | null }>;
}

export interface ShadowStore {
  isBanned(userId: string): Promise<boolean>;
  ban(userId: string, setBy: string, at: Date): Promise<void>;
  lift(userId: string): Promise<void>;
}

/** Durable derived counters (Scylla counter tables). */
export interface CountStore {
  postComments(postId: string): Promise<number>;
  replyCounts(commentIds: string[]): Promise<Map<string, number>>;
  adjustPostComments(postId: string, by: number): Promise<void>;
  adjustReplies(commentId: string, by: number): Promise<void>;
  /** The durable aggregate of votes as it stands (`vote_counts`). */
  voteTotals(targetId: string): Promise<VoteCounts>;
  /** Durable aggregate of votes, fed by the flush (`vote_counts`). */
  addVoteDeltas(
    targetId: string,
    d: { ups: number; downs: number; wups: number; wdowns: number },
  ): Promise<void>;
  /** Worklists for reconciliation: ids touched in the last 48 h of a day. */
  markVoted(targetId: string, day: number): Promise<void>;
  votedTargets(day: number, limit: number): Promise<string[]>;
  commentedPosts(day: number, limit: number): Promise<string[]>;
}

/** Fast derived counts (Redis). Every key expires. */
export interface CountCache {
  /** `null` on a miss. */
  votes(targetId: string): Promise<VoteCounts | null>;
  setVotes(targetId: string, counts: VoteCounts): Promise<void>;
  /** Atomic delta on an existing entry; `null` when the entry is absent. */
  applyVoteDelta(
    targetId: string,
    d: { dUps: number; dDowns: number; dWups: number; dWdowns: number },
  ): Promise<VoteCounts | null>;
  commentCount(postId: string): Promise<number | null>;
  setCommentCount(postId: string, count: number): Promise<void>;
  adjustCommentCount(postId: string, by: 1 | -1): Promise<void>;
  replyCount(commentId: string): Promise<number | null>;
  setReplyCount(commentId: string, count: number): Promise<void>;
  adjustReplyCount(commentId: string, by: 1 | -1): Promise<void>;
}

export interface RankedMember {
  id: string;
  score: number;
}

/** Board and thread rankings (Redis ZSETs). Members are sortable ids; every key expires. */
export interface RankCache {
  /** `false` when the ranking of this scope is absent and must be rebuilt. */
  has(scope: string): Promise<boolean>;
  /** Keyset page: score descending, member descending; `after` is the last (score, member) already returned. */
  page(
    scope: string,
    after: { score: number; member: string } | null,
    limit: number,
  ): Promise<RankedMember[]>;
  /** Adds or replaces members and trims the set to `cap`. */
  put(scope: string, members: RankedMember[], cap: number): Promise<void>;
  /** Replaces a member's score only when it is already ranked. */
  update(scope: string, member: string, score: number): Promise<void>;
  remove(scope: string, member: string): Promise<void>;
  /** Marks an (empty) ranking as built so an empty board is not rebuilt on every read. */
  all(scope: string): Promise<RankedMember[]>;
  drop(scope: string): Promise<void>;
}

export interface VoteCountDelta {
  ups: number;
  downs: number;
  wups: number;
  wdowns: number;
}

/** Durable-aggregate deltas waiting for the periodic flush (write-behind, S25 C4). */
export interface VoteDeltaBuffer {
  add(targetId: string, d: VoteCountDelta): Promise<void>;
  /** Takes everything pending, keyed by target. */
  drain(): Promise<Map<string, VoteCountDelta>>;
  /** Puts drained deltas back after a failed flush. */
  restore(deltas: Map<string, VoteCountDelta>): Promise<void>;
}

/** Zero-weight votes seen per target (FR-053). */
export interface AnomalyTracker {
  /** Records one zero-weight vote and returns every timestamp (ms) still inside the window, plus the last signal time. */
  note(
    targetId: string,
    nowMs: number,
    windowSeconds: number,
  ): Promise<{ timestamps: number[]; lastSentAt: number | null }>;
  markSent(targetId: string, nowMs: number): Promise<void>;
}

export interface PageCache {
  get(key: string): Promise<string | null>;
  set(key: string, json: string, ttlSeconds: number): Promise<void>;
  drop(postId: string): Promise<void>;
}

export interface AccountSummary {
  createdAt: Date;
}

/** Identity's directory behind an anti-corruption adapter (IV.8). */
export interface AccountDirectory {
  /** Unknown ids are absent. Throws when the directory fails. */
  lookup(userIds: string[]): Promise<Map<string, AccountSummary>>;
}

/** Catalog's board check behind an anti-corruption adapter: resolves for an `ACTIVE` product, throws otherwise. */
export interface BoardGate {
  assertOpen(productId: string): Promise<void>;
}

export interface RandomBytes {
  bytes(length: number): Uint8Array;
}

/** What a board listing needs to know about the viewer. */
export interface Viewer {
  userId: string | null;
}

export interface BoardQuery {
  boardId: string;
  sort: BoardSort;
  window: TopWindow;
  limit: number;
  cursor: string | null;
}

export const POST_STORE = Symbol('DISCUSSIONS_POST_STORE');
export const COMMENT_STORE = Symbol('DISCUSSIONS_COMMENT_STORE');
export const VOTE_STORE = Symbol('DISCUSSIONS_VOTE_STORE');
export const CLAIM_STORE = Symbol('DISCUSSIONS_CLAIM_STORE');
export const EVENT_STORE = Symbol('DISCUSSIONS_EVENT_STORE');
export const SHADOW_STORE = Symbol('DISCUSSIONS_SHADOW_STORE');
export const COUNT_STORE = Symbol('DISCUSSIONS_COUNT_STORE');
export const COUNT_CACHE = Symbol('DISCUSSIONS_COUNT_CACHE');
export const RANK_CACHE = Symbol('DISCUSSIONS_RANK_CACHE');
export const PAGE_CACHE = Symbol('DISCUSSIONS_PAGE_CACHE');
export const VOTE_DELTA_BUFFER = Symbol('DISCUSSIONS_VOTE_DELTA_BUFFER');
export const ANOMALY_TRACKER = Symbol('DISCUSSIONS_ANOMALY_TRACKER');
export const BACKFILL_STORE = Symbol('DISCUSSIONS_BACKFILL_STORE');
export const ACCOUNT_DIRECTORY = Symbol('DISCUSSIONS_ACCOUNT_DIRECTORY');
export const BOARD_GATE = Symbol('DISCUSSIONS_BOARD_GATE');
export const RANDOM_BYTES = Symbol('DISCUSSIONS_RANDOM_BYTES');
export const CURSOR_CODEC = Symbol('DISCUSSIONS_CURSOR_CODEC');
/** Driver edges (switchable in tests): the ScyllaDB client and the Redis client discussions use. */
export const SCYLLA_CLIENT = Symbol('DISCUSSIONS_SCYLLA_CLIENT');
export const REDIS_CLIENT = Symbol('DISCUSSIONS_REDIS_CLIENT');
