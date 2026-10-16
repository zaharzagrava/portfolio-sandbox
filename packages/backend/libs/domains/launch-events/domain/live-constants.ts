import {
  LIVE_REACTIONS,
  RECENT_COMMENTS as CONTRACT_RECENT_COMMENTS,
  type LiveComment,
  type LiveReaction,
} from '@marketplace-sandbox/contracts';

/** Constants of the live half of `launch-events` (S23). The tunable ones are validated config (`live-config.ts`). */

export type { LiveComment, LiveReaction };
export const ALLOWED_REACTIONS = LIVE_REACTIONS;
export type Reaction = LiveReaction;

/** Reaction counters are spread over this many hashes per (stream, second): 200k HINCRBY/s must not hit one key. */
export const REACTION_SHARDS = 8;
export const RECENT_COMMENTS = CONTRACT_RECENT_COMMENTS;
/** A viewer is dropped when it buffers more than this many bytes (chat is lossy by design). */
export const MAX_BUFFERED_BYTES = 256 * 1024;
export const KEEP_ALIVE_MS = 15_000;
export const VIEWER_REPORT_MS = 5_000;
/** A gateway instance that stopped reporting counts for nothing after this long. */
export const VIEWER_ENTRY_TTL_MS = 15_000;
export const GATEWAY_RETRY_AFTER_SECONDS = 5;

/** A `clientId` is remembered per user this long; a removal claim this long. */
export const CLIENT_ID_TTL_SEC = 10 * 60;
export const REMOVAL_CLAIM_TTL_SEC = 24 * 3600;
/** Lifetime of the per-second marker that makes the aggregation event once-only. */
export const AGGREGATION_MARKER_TTL_SEC = 30;
/** Statistics publisher: lease and tick. */
export const TICK_MS = 1_000;
export const TICKER_LEASE_MS = 3_000;
/** Cached stream state: fresh lifetime, and the lifetime of "no such stream". */
export const STATE_TTL_MS = 30_000;
export const STATE_NEGATIVE_TTL_MS = 10_000;
/** History: kept 30 days, written in groups of at most 25, throttled leftovers retried this often. */
export const HISTORY_DAYS = 30;
export const HISTORY_GROUP = 25;
export const HISTORY_RETRIES = 6;
/** Asynchronous moderation. */
export const CLASSIFIER_TIMEOUT_MS = 2_000;
export const CLASSIFIER_ATTEMPTS = 3;

export const LIVE_RECONCILE_JOB = 'launch-events.live-reconcile' as const;
export const LIVE_RECONCILE_SCHEDULE = 'launch-events-live-reconcile' as const;
/** Every 30 seconds (six-field cron, seconds first). */
export const LIVE_RECONCILE_CRON = '*/30 * * * * *';

export const LIVE_CONSUMER_HISTORY = 'live-comments-history' as const;
export const LIVE_CONSUMER_MODERATION = 'live-moderation' as const;
