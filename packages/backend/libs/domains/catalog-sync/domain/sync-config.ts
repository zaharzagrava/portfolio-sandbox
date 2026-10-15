/**
 * The numbers of offline sync (spec Assumptions: "numbers are configuration, not contract"). Defaults here; the keys
 * `offline_sync_*` of `catalog-sync-config.ts` override them and are validated at startup (positive integers).
 */
export interface SyncConfig {
  /** Operations per push. */
  maxOps: number;
  /** Request body cap in bytes. */
  bodyLimitBytes: number;
  /** Processing budget of one push: no new operation starts after it. */
  pushBudgetMs: number;
  /** A claim younger than this answers `in_flight`; an older one may be taken over. */
  claimLeaseMs: number;
  /** The recovery job completes claims older than this. */
  recoveryAfterMs: number;
  /** Largest accepted lead of a field edit's clock over the server's. */
  clockDriftMs: number;
  /** An operation clock older than this is `op_expired`; also the feed's compaction age and tombstone horizon. */
  maxOpAgeMs: number;
  /** Operation records are purged after this. */
  retentionMs: number;
}

const DAY = 86_400_000;

export const SYNC_DEFAULTS: SyncConfig = {
  maxOps: 500,
  bodyLimitBytes: 2 * 1024 * 1024,
  pushBudgetMs: 20_000,
  claimLeaseMs: 60_000,
  recoveryAfterMs: 5 * 60_000,
  clockDriftMs: 60_000,
  maxOpAgeMs: 30 * DAY,
  retentionMs: 90 * DAY,
};

type Reader = (key: SyncConfigKey) => number | undefined;
export type SyncConfigKey =
  | 'offline_sync_max_ops'
  | 'offline_sync_body_limit_bytes'
  | 'offline_sync_push_budget_ms'
  | 'offline_sync_claim_lease_ms'
  | 'offline_sync_recovery_after_ms'
  | 'offline_sync_clock_drift_ms'
  | 'offline_sync_max_op_age_ms'
  | 'offline_sync_retention_ms';

/** Resolves and cross-checks the settings; a contradiction fails startup naming the keys. */
export function resolveSyncConfig(get: Reader): SyncConfig {
  const config: SyncConfig = {
    maxOps: get('offline_sync_max_ops') ?? SYNC_DEFAULTS.maxOps,
    bodyLimitBytes:
      get('offline_sync_body_limit_bytes') ?? SYNC_DEFAULTS.bodyLimitBytes,
    pushBudgetMs:
      get('offline_sync_push_budget_ms') ?? SYNC_DEFAULTS.pushBudgetMs,
    claimLeaseMs:
      get('offline_sync_claim_lease_ms') ?? SYNC_DEFAULTS.claimLeaseMs,
    recoveryAfterMs:
      get('offline_sync_recovery_after_ms') ?? SYNC_DEFAULTS.recoveryAfterMs,
    clockDriftMs:
      get('offline_sync_clock_drift_ms') ?? SYNC_DEFAULTS.clockDriftMs,
    maxOpAgeMs: get('offline_sync_max_op_age_ms') ?? SYNC_DEFAULTS.maxOpAgeMs,
    retentionMs: get('offline_sync_retention_ms') ?? SYNC_DEFAULTS.retentionMs,
  };
  const problems: string[] = [];
  if (config.maxOps > 500) problems.push('offline_sync_max_ops must be <= 500');
  if (config.recoveryAfterMs < config.claimLeaseMs)
    problems.push(
      'offline_sync_recovery_after_ms must not be below offline_sync_claim_lease_ms',
    );
  if (config.retentionMs <= config.maxOpAgeMs)
    problems.push(
      'offline_sync_retention_ms must exceed offline_sync_max_op_age_ms (a replay must meet its record)',
    );
  if (problems.length)
    throw new Error(`invalid offline sync settings: ${problems.join('; ')}`);
  return config;
}
