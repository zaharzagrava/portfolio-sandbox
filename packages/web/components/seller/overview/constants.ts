/** Timing of the overview's live behaviour (W04 contracts/web-modules.md "Events and timing constants"). */

/** No frame for this long and the live panel says "Reconnecting…" and dims its numbers (AS-21). */
export const LIVE_STALE_MS = 5_000;
/** Frames that show new orders refresh the period numbers at most this often (AS-24). */
export const PERIOD_INVALIDATE_MIN_MS = 30_000;
/** A refused stream falls back to refetching "Today (UTC)" this often while the tab is visible (AS-22). */
export const TODAY_POLL_MS = 30_000;
