/** Limits of the collaborative editor (S06 Assumptions). One place, so tests and code read the same numbers. */
export const DRAFT_LIMITS = {
  connectionsPerRoom: 50,
  connectionsPerUser: 5,
  frameBytes: 512 * 1024,
  documentBytes: 2 * 1024 * 1024,
  framesPerSecond: 200,
  presenceBytes: 8 * 1024,
  pingMs: 30_000,
  presenceSilenceMs: 30_000,
  idleUnloadMs: 30_000,
  openDraftsPerShop: 200,
  versionsPerDraft: 200,
  backlogBytes: 8 * 1024 * 1024,
  backlogMs: 30_000,
  logEntryBytes: 300 * 1024,
  freezeTimeoutMs: 3_000,
  publishLeaseMs: 60_000,
  ticketTtlSeconds: 60,
  flushBatchMs: 100,
  flushesPerCompaction: 200,
  recheckMs: 60_000,
  ringHeartbeatMs: 5_000,
  ringTtlMs: 15_000,
  ringRefreshMs: 2_000,
  purgeBatch: 100,
  supersededGraceMs: 10 * 60_000,
  orphanObjectAgeMs: 60 * 60_000,
  dynamoTimeoutMs: 1_000,
  s3TimeoutMs: 3_000,
  redisTimeoutMs: 250,
} as const;

/**
 * The periods a spec shortens by configuration instead of sleeping (S06 test plan): provided under `COLLAB_TIMINGS`, the
 * defaults are the limits above.
 */
export interface CollabTimings {
  pingMs: number;
  presenceSilenceMs: number;
  idleUnloadMs: number;
  recheckMs: number;
  flushBatchMs: number;
  /** First retry delay of a failed log write; doubles up to `retryCapMs`, full jitter. */
  retryBaseMs: number;
  retryCapMs: number;
}

export const COLLAB_TIMINGS = Symbol('COLLAB_TIMINGS');

export const DEFAULT_COLLAB_TIMINGS: CollabTimings = {
  pingMs: DRAFT_LIMITS.pingMs,
  presenceSilenceMs: DRAFT_LIMITS.presenceSilenceMs,
  idleUnloadMs: DRAFT_LIMITS.idleUnloadMs,
  recheckMs: DRAFT_LIMITS.recheckMs,
  flushBatchMs: DRAFT_LIMITS.flushBatchMs,
  retryBaseMs: 50,
  retryCapMs: 1_000,
};
