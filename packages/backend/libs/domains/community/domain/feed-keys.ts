/**
 * Redis keys of the feed (S26 data-model.md, III.9): everything under the `fd:` prefix, every key with a TTL, derived and
 * rebuildable from the durable tables. The user or account id is wrapped in a hash tag so related keys of one subject
 * land in one slot on a cluster. No `KEYS`/`SCAN` ever walks these.
 */
export const FEED_KEY_PREFIX = 'fd:';

const DAY = 86_400;

/** Seconds. */
export const FEED_TTL = {
  /** Active marker; slides on each feed read. */
  act: 7 * DAY,
  /** Timeline ZSET; renewed on each write. */
  tl: 7 * DAY,
  /** "Timeline complete" marker. */
  tlc: 7 * DAY,
  /** Single-flight rebuild lock (10 s). */
  rb: 10,
  /** Celebrity recents; renewed on each new item. */
  cel: DAY,
  /** Read-through cache of celebrity membership (a promotion overwrites a cached "no" at once). */
  iscel: 3_600,
  /** Cached "not a celebrity": short, so a promotion made elsewhere is seen quickly. */
  iscelNegative: 300,
  /** Followed celebrities of a user. */
  cf: 3_600,
} as const;

/** Active marker of a user (read the feed within the active window). */
export const activeKey = (userId: string) => `fd:act:{${userId}}`;
/** Pushed timeline of a user: ZSET, member = sortable item id, score = milliseconds. */
export const timelineKey = (userId: string) => `fd:tl:{${userId}}`;
/** Set only when a rebuild read every followed author; cleared by follow and unfollow. */
export const timelineCompleteKey = (userId: string) => `fd:tlc:{${userId}}`;
/** Single-flight rebuild lock (`SET NX PX`). */
export const rebuildLockKey = (userId: string) => `fd:rb:{${userId}}`;
/** The newest items of a celebrity author: ZSET. */
export const celebrityRecentsKey = (authorId: string) => `fd:cel:{${authorId}}`;
/** `0`/`1` read-through cache of `celebrity_accounts` membership; one key per account, never a global set. */
export const isCelebrityKey = (accountId: string) => `fd:iscel:{${accountId}}`;
/** JSON list of the celebrities a user follows. */
export const followedCelebritiesKey = (userId: string) => `fd:cf:{${userId}}`;
