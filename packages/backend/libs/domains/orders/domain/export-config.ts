/** Injection token of the validated export settings (bound by `infra/export-config.provider.ts`). */
export const EXPORT_CONFIG = Symbol('EXPORT_CONFIG');

/** Export configuration and its start-up validation (S12 AS-59). Pure: the caller passes the parsed values. */
export interface ExportConfig {
  batchSize: number;
  rowLimit: number;
  deadlineSec: number;
  leaseSec: number;
  heartbeatSec: number;
  storageInactivitySec: number;
  fileRetentionDays: number;
  recordRetentionDays: number;
  linkTtlSec: number;
  unclaimedSec: number;
  userContentOrigin: string | null;
}

export const EXPORT_CONFIG_DEFAULTS: Readonly<ExportConfig> = {
  batchSize: 1000,
  rowLimit: 20_000_000,
  deadlineSec: 7200,
  leaseSec: 300,
  heartbeatSec: 60,
  storageInactivitySec: 60,
  fileRetentionDays: 7,
  recordRetentionDays: 90,
  linkTtlSec: 600,
  unclaimedSec: 120,
  userContentOrigin: null,
};

/** Environment key each field is read from; messages name the key. */
export const EXPORT_CONFIG_KEYS: Readonly<Record<keyof ExportConfig, string>> =
  {
    batchSize: 'ORDER_EXPORT_BATCH_SIZE',
    rowLimit: 'ORDER_EXPORT_ROW_LIMIT',
    deadlineSec: 'ORDER_EXPORT_DEADLINE_SEC',
    leaseSec: 'ORDER_EXPORT_LEASE_SEC',
    heartbeatSec: 'ORDER_EXPORT_HEARTBEAT_SEC',
    storageInactivitySec: 'ORDER_EXPORT_STORAGE_INACTIVITY_SEC',
    fileRetentionDays: 'ORDER_EXPORT_FILE_RETENTION_DAYS',
    recordRetentionDays: 'ORDER_EXPORT_RECORD_RETENTION_DAYS',
    linkTtlSec: 'ORDER_EXPORT_LINK_TTL_SEC',
    unclaimedSec: 'ORDER_EXPORT_UNCLAIMED_SEC',
    // The platform's existing user-content origin (S29/S30); required in production for download links.
    userContentOrigin: 'USERCONTENT_ORIGIN',
  };

export interface ExportConfigIssue {
  key: string;
  message: string;
}

export function validateExportConfig(
  config: ExportConfig,
  options: { production: boolean },
): ExportConfigIssue[] {
  const issues: ExportConfigIssue[] = [];
  const K = EXPORT_CONFIG_KEYS;
  const positiveInt = (field: keyof ExportConfig, min = 1): void => {
    const v = config[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min)
      issues.push({
        key: K[field],
        message: `${K[field]} must be an integer >= ${min}`,
      });
  };
  positiveInt('batchSize');
  positiveInt('rowLimit');
  positiveInt('deadlineSec');
  positiveInt('heartbeatSec');
  positiveInt('storageInactivitySec');
  positiveInt('fileRetentionDays');
  positiveInt('recordRetentionDays');
  positiveInt('linkTtlSec');
  positiveInt('unclaimedSec');
  positiveInt('leaseSec');
  if (
    Number.isFinite(config.leaseSec) &&
    Number.isFinite(config.heartbeatSec) &&
    config.leaseSec < 2 * config.heartbeatSec
  )
    issues.push({
      key: K.leaseSec,
      message: `${K.leaseSec} must be at least 2 x ${K.heartbeatSec}`,
    });
  if (options.production && !config.userContentOrigin?.trim())
    issues.push({
      key: K.userContentOrigin,
      message: `${K.userContentOrigin} is required in production`,
    });
  return issues;
}
