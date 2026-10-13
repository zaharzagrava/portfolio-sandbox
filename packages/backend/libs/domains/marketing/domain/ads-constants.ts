/** Topics owned by `marketing` (ads half). */
export const ADS_CLICKS_TOPIC = 'ads.clicks';
export const ADS_AGGREGATES_TOPIC = 'ads.click-aggregates';
export const ADS_CLICKS_DLQ_TOPIC = 'ads.clicks.dlq';

/** A click token is valid for 30 minutes after it was served (FR-013). */
export const TOKEN_TTL_MS = 30 * 60_000;
/** The dedupe marker outlives the token by 5 minutes, so clock skew cannot open a second count (FR-022). */
export const MARKER_TTL_SECONDS = 35 * 60;

/** Explicit timeouts of every outbound call on the hot paths (FR-072). */
export const STORE_TIMEOUT_MS = 100;
export const PUBLISH_TIMEOUT_MS = 1_000;
export const ANALYTICS_TIMEOUT_MS = 10_000;

/** Up to this many campaigns are read per category before the one-per-shop cut (questions.md LOCAL). */
export const SERVE_CANDIDATE_LIMIT = 50;

/** The first hour of a day is billed no earlier than this long after the hour ended (FR-040). */
export const HOUR_CLOSE_GRACE_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Reconciliation looks at the last 3 closed days; a RUNNING row older than this is abandoned (R-11). */
export const RECONCILE_WINDOW_DAYS = 3;
export const RECONCILE_STALE_MS = 30 * 60_000;
export const DRIFT_WARN_RATIO = 0.01;

/** Clicks stamped further ahead / behind than this are refused by the aggregator (AS-47). */
export const CLICK_MAX_FUTURE_MS = 5 * 60_000;
export const CLICK_MAX_AGE_MS = 7 * DAY_MS;
