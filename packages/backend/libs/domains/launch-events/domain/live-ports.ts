import type { LiveStatus } from './live-state';
import type { LiveComment, Reaction } from './live-constants';

/**
 * Ports of the live half (S23 IV.8, D-6): `application/` talks to these tokens only; the adapters live in `infra/`. Every
 * store behind a port can be switched off in tests by a wrapper at the system edge (fault injection).
 */

export interface StoredPin {
  productId: string;
  productTitle: string;
  text: string;
  stockLeft?: number;
  pinnedAt: string;
}

export interface LiveStreamRecord {
  id: string;
  shopId: string;
  title: string;
  status: LiveStatus;
  launchEventId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  pin: StoredPin | null;
  /** Version of the last pin change; 0 before any, kept when the pin is cleared. */
  pinVersion: number;
}

export type PinChange =
  { kind: 'keep' } | { kind: 'set'; pin: StoredPin } | { kind: 'clear' };

export interface LiveStreamRepository {
  create(input: {
    shopId: string;
    title: string;
    launchEventId: string | null;
  }): Promise<LiveStreamRecord>;
  findById(id: string): Promise<LiveStreamRecord | null>;
  /**
   * `UPDATE … WHERE id AND "shopId" AND status = :from`, asserting one row; ending clears the pin (the version stays).
   * Returns the new record, or `null` when no row matched. Joins the active transaction.
   */
  transition(input: {
    id: string;
    shopId: string;
    from: LiveStatus;
    to: 'LIVE' | 'ENDED';
    at: Date;
  }): Promise<LiveStreamRecord | null>;
  /**
   * Reads the stream of the shop under a row lock, asks `decide` what to do and applies it (version + 1 for a set or a
   * clear) in one transaction. `null` when the stream does not exist in that shop.
   */
  changePin(
    id: string,
    shopId: string,
    decide: (current: LiveStreamRecord) => PinChange,
  ): Promise<{ record: LiveStreamRecord; changed: boolean } | null>;
  listLiveIds(): Promise<string[]>;
}

export interface LiveMuteRepository {
  /** Idempotent. */
  mute(
    streamId: string,
    userId: string,
    mutedBy: string,
    at: Date,
  ): Promise<void>;
  unmute(streamId: string, userId: string): Promise<void>;
  listByStream(streamId: string): Promise<string[]>;
}

/** The last comments of a stream, newest kept, in the fast store. */
export interface RecentCommentStore {
  /** Idempotent: adding the same comment twice leaves one entry. */
  add(comment: LiveComment): Promise<void>;
  /** Ascending by id. */
  list(streamId: string): Promise<LiveComment[]>;
  /** `true` when the comment was on the list. */
  remove(streamId: string, commentId: string): Promise<boolean>;
}

/** The private comment feed the gateways' batchers read. */
export interface CommentFeed {
  publish(comment: LiveComment): Promise<void>;
}

/** Mutes in the fast store, a cache of `LiveMuteRepository`, rebuilt on a miss. */
export interface MuteCache {
  /** `null` when the stream's set is not cached (never filled, expired or wiped). */
  isMuted(streamId: string, userId: string): Promise<boolean | null>;
  fill(streamId: string, userIds: string[]): Promise<void>;
  add(streamId: string, userId: string): Promise<void>;
  remove(streamId: string, userId: string): Promise<void>;
}

export interface ReactionCounters {
  add(
    streamId: string,
    second: number,
    reactions: Partial<Record<Reaction, number>>,
  ): Promise<void>;
  totals(streamId: string, second: number): Promise<Record<string, number>>;
}

export interface ViewerCounts {
  report(
    streamId: string,
    instance: string,
    count: number,
    nowMs: number,
  ): Promise<void>;
  clear(streamId: string, instance: string): Promise<void>;
  /** Sum of the entries younger than the freshness window. */
  total(streamId: string, nowMs: number): Promise<number>;
}

/** The set of `LIVE` streams the statistics publisher walks (derived, rebuilt by the reconcile job). */
export interface ActiveStreams {
  add(streamId: string): Promise<void>;
  remove(streamId: string): Promise<void>;
  list(): Promise<string[]>;
  /** Makes the set equal to `ids`; reports what changed. */
  replace(ids: string[]): Promise<{ added: number; removed: number }>;
}

export interface ClientIdRecord {
  id: string;
  at: number;
  text: string;
  /**
   * `pending` until the event is durable, `durable` until the comment is visible, then `done`. `failed` marks a comment
   * that is durable but could not be made visible: a retry finishes it at once instead of waiting.
   */
  state: 'pending' | 'durable' | 'failed' | 'done';
}

/** `clientId` claims per user and stream: a retried post never makes a second comment (FR-023). */
export interface ClientIds {
  /** `claimed` for the first caller; `exists` with the stored record otherwise. */
  claim(
    streamId: string,
    userId: string,
    clientId: string,
    record: ClientIdRecord,
  ): Promise<
    { result: 'claimed' } | { result: 'exists'; record: ClientIdRecord }
  >;
  read(
    streamId: string,
    userId: string,
    clientId: string,
  ): Promise<ClientIdRecord | null>;
  setState(
    streamId: string,
    userId: string,
    clientId: string,
    state: ClientIdRecord['state'],
  ): Promise<void>;
  release(streamId: string, userId: string, clientId: string): Promise<void>;
}

/** At most one removal event per comment within 24 hours (FR-027). */
export interface RemovalClaims {
  claim(streamId: string, commentId: string): Promise<boolean>;
  /** Whether a removal of this comment was claimed within the window (it proves the comment existed). */
  isClaimed(streamId: string, commentId: string): Promise<boolean>;
  release(streamId: string, commentId: string): Promise<void>;
}

/** Who publishes the statistics of a stream, and which second was already published or aggregated. */
export interface TickerCoordination {
  holdLease(streamId: string, me: string): Promise<boolean>;
  releaseLease(streamId: string, me: string): Promise<void>;
  /** `true` for the first caller per (stream, second). */
  claimStats(streamId: string, second: number): Promise<boolean>;
  claimAggregation(streamId: string, second: number): Promise<boolean>;
  releaseAggregation(streamId: string, second: number): Promise<void>;
}

export interface HistoryPage {
  items: LiveComment[];
  nextCursor: string | null;
}

/** The thirty-day history (DynamoDB). */
export interface CommentHistoryReader {
  /** Whether the comment is in the history (removed or not). */
  exists(streamId: string, commentId: string): Promise<boolean>;
  page(input: {
    streamId: string;
    minute: string;
    limit: number;
    cursor?: string;
  }): Promise<HistoryPage>;
}

/** Scores a text from 0 (fine) to 1 (toxic). A slow or failing classifier is the caller's problem (timeout, retry). */
export interface ToxicityClassifier {
  score(text: string): Promise<number>;
}

export const LIVE_STREAMS = Symbol('LIVE_STREAMS');
export const LIVE_MUTES = Symbol('LIVE_MUTES');
export const RECENT_COMMENT_STORE = Symbol('RECENT_COMMENT_STORE');
export const COMMENT_FEED = Symbol('COMMENT_FEED');
export const MUTE_CACHE = Symbol('MUTE_CACHE');
export const REACTION_COUNTERS = Symbol('REACTION_COUNTERS');
export const VIEWER_COUNTS = Symbol('VIEWER_COUNTS');
export const ACTIVE_STREAM_SET = Symbol('ACTIVE_STREAM_SET');
export const CLIENT_IDS = Symbol('CLIENT_IDS');
export const REMOVAL_CLAIMS = Symbol('REMOVAL_CLAIMS');
export const TICKER_COORDINATION = Symbol('TICKER_COORDINATION');
export const COMMENT_HISTORY_READER = Symbol('COMMENT_HISTORY_READER');
export const TOXICITY_CLASSIFIER = Symbol('TOXICITY_CLASSIFIER');
/** Live settings (window, sample size, viewer cap, threshold), validated at start. */
export const LIVE_SETTINGS = Symbol('LIVE_SETTINGS');
/** The gateway's timer source (injectable so a spec drives windows and keep-alives by hand). */
export const LIVE_TIMERS = Symbol('LIVE_TIMERS');

export interface LiveSettings {
  windowMs: number;
  sampleSize: number;
  viewerCap: number;
  moderationThreshold: number;
  /** A viewer buffering more than this is closed (default 256 KB; not an environment setting, specs lower it). */
  maxBufferedBytes?: number;
}

export interface LiveTimers {
  /** Runs `fn` every `ms`; returns the stop function. */
  every(ms: number, fn: () => void): () => void;
}
