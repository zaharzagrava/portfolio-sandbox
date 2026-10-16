import type {
  BoardSort,
  FeedItemKind,
  TopWindow,
} from '@marketplace-sandbox/contracts';
import type { VoteCounts, VoteRecord } from './vote-transition';
import type {
  GuardResult,
  ProductCopy,
  ProductCopyEvent,
} from './version-guard';

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

/* ------------------------------------------------------------------------------------------------------------------
 * Follow graph and home feed (S26, D-6, E2): ports of `application/` over ScyllaDB, Redis and other domains' R1
 * exports. `application/` imports these interfaces and tokens only; `infra/` binds them (constitution I.1-I.3).
 * ---------------------------------------------------------------------------------------------------------------- */

/** The durable follow graph: buyer-side truth with a per-relation sequence, derived sides converge by timestamp. */
export interface FollowEdge {
  accountId: string;
  followedAt: Date;
}

export type FollowOutcome =
  /** The relation became active by this call. */
  | 'followed'
  /** It already was active: nothing changed. */
  | 'already_following'
  | 'limit_reached';

export type UnfollowOutcome = 'unfollowed' | 'not_following';

export interface FollowStatusEntry {
  accountId: string;
  following: boolean;
  followerCount: number;
}

export interface FollowGraphStore {
  /** Conditional write; counts move only when this call applied the transition. */
  follow(
    userId: string,
    accountId: string,
    limit: number,
    at: Date,
  ): Promise<FollowOutcome>;
  unfollow(
    userId: string,
    accountId: string,
    at: Date,
  ): Promise<UnfollowOutcome>;
  /** Newest follow first; keyset `(followedAtMs, accountId)` strictly after `after`. */
  list(
    userId: string,
    after: { followedAtMs: number; accountId: string } | null,
    limit: number,
  ): Promise<FollowEdge[]>;
  /** Every account the user follows (pull side; reads the whole partition, paged). */
  allFollowing(userId: string): Promise<string[]>;
  status(userId: string, accountIds: string[]): Promise<FollowStatusEntry[]>;
  followerCount(accountId: string): Promise<number>;
  /** Active followers of an account, paged by follower id; `after` is the last id already returned. */
  followerIds(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<string[]>;

  /* Reconciliation (A7, AS-51): every repair of a derived side lives in the store that owns the timestamps. */
  /** One page of distinct buyers that have a relation row; `next` resumes the scan (null when done). */
  scanUsers(after: string | null, size: number): Promise<ScanPage>;
  /** One page of buyers that have list entries but no relation row at all (what `scanUsers` cannot reach). */
  scanOrphanedIndexUsers(after: string | null, size: number): Promise<ScanPage>;
  /** One page of distinct accounts that have a follower record. */
  scanFollowedAccounts(after: string | null, size: number): Promise<ScanPage>;
  /** One page of accounts whose stored follower counter is not zero. */
  scanCounters(after: string | null, size: number): Promise<ScanPage>;
  hasFollowerRecords(accountId: string): Promise<boolean>;
  /** Completes or removes the derived rows of every relation of a buyer and recomputes the reservation counter. */
  repairUser(userId: string, now: Date, graceMs: number): Promise<number>;
  /** Removes follower records without a buyer-side relation and recomputes the follower counter. */
  repairAccount(accountId: string, now: Date, graceMs: number): Promise<number>;
}

export interface ScanPage {
  ids: string[];
  next: string | null;
}

/** Cached derived state of a user's timeline that a follow or an unfollow makes stale (`fd:tlc`, `fd:cf`). */
export interface FollowCacheInvalidator {
  invalidate(userId: string): Promise<void>;
}

/** The unprefixed Redis keys of the previous implementation, removed once by explicit name (never `KEYS`/`SCAN`). */
export interface LegacyKeyCleaner {
  isDone(): Promise<boolean>;
  unlink(keys: string[]): Promise<void>;
  markDone(): Promise<void>;
}

/** An item as stored in `feed_items` (the payload is the typed JSON of its kind). */
export interface StoredFeedItem {
  itemId: string;
  authorId: string;
  kind: FeedItemKind;
  title: string;
  payload: Record<string, string | number>;
  createdAt: Date;
  productId: string | null;
  shopId: string | null;
  postId: string | null;
}

export interface AuthorHistoryEntry {
  itemId: string;
  createdAt: Date;
}

export interface StoreItemOptions {
  /** TTL of the claim row (`price_drop`: 24 h); null = the claim lives as long as the source. */
  claimTtlSeconds: number | null;
  /** TTL of the item and history rows (the retention, 90 days). */
  ttlSeconds: number;
  /** Write time: picks the relay shard of the announcement. */
  now: Date;
}

export interface FeedItemStore {
  /**
   * `INSERT ... IF NOT EXISTS` on the claim of (kind, sourceKey), then one logged batch (item, author history,
   * pending announcement). `created: false` when another delivery already owns the source and stored its item.
   * `item.itemId` is the id offered for a new claim; the id of the claim winner is returned.
   */
  store(
    item: StoredFeedItem,
    sourceKey: string,
    options: StoreItemOptions,
  ): Promise<{ created: boolean; itemId: string }>;
  /** Items by uuid; missing (expired) ids are absent. */
  getMany(itemIds: string[]): Promise<StoredFeedItem[]>;
  /**
   * Newest first by `(ms, sortable id)`, strictly older than `before` (sortable id) when given, no older than
   * `notBefore`; starts from the month of `before`, or of `now`.
   */
  authorHistory(
    authorId: string,
    before: { ms: number; itemId: string } | null,
    notBefore: Date,
    limit: number,
    now: Date,
  ): Promise<AuthorHistoryEntry[]>;
}

/** The pushed-timeline cache (Redis) failed or timed out: reads fall back to pull, pushes retry (S26 D6). */
export class TimelineUnavailableError extends Error {
  constructor() {
    super('timeline store unavailable');
    this.name = 'TimelineUnavailableError';
  }
}

export interface TimelineEntryRow {
  ms: number;
  /** Sortable item id. */
  itemId: string;
}

export interface TimelineStore {
  /** Pushes one entry to each of the users' timelines (trimmed to the window); the caller passes active users only. */
  push(
    userIds: string[],
    entry: TimelineEntryRow,
    window: number,
  ): Promise<void>;
  /** The newest entries of a user's pushed timeline, newest first, strictly after the cursor. */
  read(
    userId: string,
    before: TimelineEntryRow | null,
    limit: number,
  ): Promise<TimelineEntryRow[]>;
  /** Which of these users read the feed within the active window (one pipelined round trip). */
  activeAmong(userIds: string[]): Promise<Set<string>>;
  /** Marks a user active and slides the marker; returns whether the marker was set before. */
  touchActive(userId: string): Promise<boolean>;
  markActive(userId: string): Promise<void>;
  /** The last rebuild read every author and the pushed timeline it produced is still there (or was empty). */
  isComplete(userId: string): Promise<boolean>;
  /** `empty`: the rebuild found no entry, so an absent timeline is expected. */
  markComplete(userId: string, empty: boolean): Promise<void>;
  /** Follow and unfollow clear the completion marker and the cached celebrity list. */
  invalidate(userId: string): Promise<void>;
  /** Merges rebuilt entries into the existing timeline so a concurrent push survives. */
  merge(
    userId: string,
    entries: TimelineEntryRow[],
    window: number,
  ): Promise<void>;
  /** Single-flight rebuild lock; `true` when this caller owns it. */
  acquireRebuild(userId: string): Promise<boolean>;
  releaseRebuild(userId: string): Promise<void>;
  /** Celebrity recents: pushed on a new item, read newest first; `null` when absent (must be rebuilt). */
  pushRecent(
    authorId: string,
    entry: TimelineEntryRow,
    cap: number,
  ): Promise<void>;
  recents(
    authorId: string,
    before: TimelineEntryRow | null,
    limit: number,
  ): Promise<TimelineEntryRow[] | null>;
  putRecents(
    authorId: string,
    entries: TimelineEntryRow[],
    cap: number,
  ): Promise<void>;
  followedCelebrities(userId: string): Promise<string[] | null>;
  setFollowedCelebrities(userId: string, accountIds: string[]): Promise<void>;
}

export interface CelebrityStore {
  isCelebrity(accountId: string): Promise<boolean>;
  /** Many at once (cache first, table on a miss). */
  areCelebrities(accountIds: string[]): Promise<Set<string>>;
  /** `IF NOT EXISTS`; sticky. Returns true when this call promoted the account. */
  promote(accountId: string, followers: number, at: Date): Promise<boolean>;
}

export interface ProductCopyStore {
  get(productId: string): Promise<ProductCopy | null>;
  getMany(productIds: string[]): Promise<Map<string, ProductCopy>>;
  /** Version-guarded upsert; returns the copy after the guard ran. */
  apply(event: ProductCopyEvent, at: Date): Promise<GuardResult>;
  isPostDeleted(postId: string): Promise<boolean>;
  tombstonePost(postId: string, at: Date): Promise<void>;
}

export interface PendingAnnouncement {
  hourShard: number;
  itemId: string;
  authorId: string;
  kind: FeedItemKind;
  createdAt: Date;
}

export interface AnnouncementStore {
  pending(hourShards: number[], limit: number): Promise<PendingAnnouncement[]>;
  delivered(row: PendingAnnouncement): Promise<void>;
  deadLetter(
    row: PendingAnnouncement,
    reason: string,
    day: number,
  ): Promise<void>;
  /** Fan-out completion marker (`fanout_done`). */
  isFannedOut(itemId: string): Promise<boolean>;
  markFannedOut(itemId: string, at: Date): Promise<void>;
}

/** Shops behind an anti-corruption adapter over S03 `getShopsByIds` (IV.8). Unknown ids are absent. */
export interface ShopInfo {
  shopId: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED' | string;
  isSandbox: boolean;
}
export interface FeedShopDirectory {
  lookup(shopIds: string[]): Promise<Map<string, ShopInfo>>;
}

/** Users behind an anti-corruption adapter over S01 `getUsersByIds`; deleted users are absent. */
export interface FeedAccountDirectory {
  existing(userIds: string[]): Promise<Set<string>>;
}

/** Posts behind an anti-corruption adapter over S25 `getPostsByIds`; deleted and shadow posts are absent. */
export interface PostSummary {
  postId: string;
  boardId: string;
  authorId: string;
  title: string;
  createdAt: Date;
}
export interface FeedPostLookup {
  lookup(postIds: string[]): Promise<Map<string, PostSummary>>;
}

export const FOLLOW_GRAPH_STORE = Symbol('FEED_FOLLOW_GRAPH_STORE');
export const FEED_ITEM_STORE = Symbol('FEED_ITEM_STORE');
export const TIMELINE_STORE = Symbol('FEED_TIMELINE_STORE');
export const CELEBRITY_STORE = Symbol('FEED_CELEBRITY_STORE');
export const PRODUCT_COPY_STORE = Symbol('FEED_PRODUCT_COPY_STORE');
export const ANNOUNCEMENT_STORE = Symbol('FEED_ANNOUNCEMENT_STORE');
export const FEED_SHOP_DIRECTORY = Symbol('FEED_SHOP_DIRECTORY');
export const FEED_ACCOUNT_DIRECTORY = Symbol('FEED_ACCOUNT_DIRECTORY');
export const FEED_POST_LOOKUP = Symbol('FEED_POST_LOOKUP');
export const FEED_CURSOR_CODEC = Symbol('FEED_CURSOR_CODEC');
/** Random bytes for the time-based ids of items (the domain never touches `node:crypto`). */
export const FEED_RANDOM_BYTES = Symbol('FEED_RANDOM_BYTES');
export const FOLLOW_CACHE_INVALIDATOR = Symbol('FEED_FOLLOW_CACHE_INVALIDATOR');
export const LEGACY_KEY_CLEANER = Symbol('FEED_LEGACY_KEY_CLEANER');
/** The time source of the feed is the platform `CLOCK` token (`@app/common/core/clock`); tests bind a `FakeClock`. */
/** Driver edges of the feed (switchable in tests): the ScyllaDB client and the Redis client the feed uses. */
export const FEED_SCYLLA_CLIENT = Symbol('FEED_SCYLLA_CLIENT');
export const FEED_REDIS_CLIENT = Symbol('FEED_REDIS_CLIENT');
