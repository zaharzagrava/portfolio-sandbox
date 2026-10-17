/** Politeness and scheduling numbers of the competitor crawler that are fixed by the spec (S41 Assumptions). */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** A registration never makes a target due that was checked within this long (FR-004). */
export const COMPETITOR_FRESHNESS_MS = HOUR_MS;
/** A queue mark older than this is replaced, so an entry lost with its worker is queued again (FR-011). */
export const QUEUE_MARK_STALE_MS = 15 * MINUTE_MS;
/** Robots, page and redirects of one target never take longer (FR-014). */
export const CRAWL_BUDGET_MS = 30_000;
/** `Crawl-delay` is capped here (FR-015). */
export const MAX_CRAWL_DELAY_MS = 300_000;
/** A worker that is stopped abandons what is still in flight after this long (FR-020). */
export const SHUTDOWN_GRACE_MS = 30_000;
/** Retired targets are deleted after this long without a watch (FR-032). */
export const RETIRED_RETENTION_MS = 30 * 24 * HOUR_MS;

/** robots.txt cache lifetimes by outcome (FR-016). */
export const ROBOTS_TTL_SECONDS = {
  rules: 24 * 3600,
  allowAll: 3600,
  unavailable: 15 * 60,
} as const;
