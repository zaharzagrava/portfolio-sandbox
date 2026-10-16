import {
  IMPORT_MAX_BYTES,
  IMPORT_PART_BYTES,
} from '@marketplace-sandbox/contracts';

/**
 * The numbers of the bulk import (S07 D-25). Fixed by contract: the batch, the part size, the maximum file, the record
 * limit, the lease, the caps, the retentions and the report link; they are constants with a bounds check. The few that
 * operations may tune are read from the environment by `resolveImportConfig`.
 */
const MINUTE = 60_000;
const DAY = 86_400_000;

export const IMPORT_LIMITS = {
  batchSize: 500,
  partBytes: IMPORT_PART_BYTES,
  maxBytes: IMPORT_MAX_BYTES,
  recordBytes: 1_048_576,
  activePerShop: 3,
  startsPerHour: 10,
  uploadExpiryMs: 24 * 60 * MINUTE,
  uploadUrlTtlSec: 6 * 3600,
  leaseMs: 5 * MINUTE,
  leaseRenewMs: MINUTE,
  recoveryAfterMs: 2 * MINUTE,
  deliveryBudget: 3,
  reportLinkTtlSec: 600,
  reportRetentionMs: 30 * DAY,
  recordRetentionMs: 90 * DAY,
  purgePerRun: 500,
  sniffBytes: 4096,
} as const;

/** Injection token of the resolved `ImportConfig`. */
export const IMPORT_CONFIG = Symbol('IMPORT_CONFIG');

export interface ImportConfig {
  /** Failed rows tolerated before the import stops `too_many_errors`. */
  errorCap: number;
  /** Delay (seconds) of a job handed back because its shop is busy; jittered by plus or minus 20 percent. */
  busyDelaySeconds: number;
  scanInactivityMs: number;
  scanTotalMs: number;
}

export const IMPORT_CONFIG_DEFAULTS: ImportConfig = {
  errorCap: 100_000,
  busyDelaySeconds: 60,
  scanInactivityMs: MINUTE,
  scanTotalMs: 30 * MINUTE,
};

export type ImportConfigKey =
  | 'IMPORT_ERROR_CAP'
  | 'IMPORT_BUSY_DELAY_SECONDS'
  | 'IMPORT_SCAN_INACTIVITY_MS'
  | 'IMPORT_SCAN_TOTAL_MS';

/** Resolves and validates the settings; a value out of range stops startup naming the key. */
export function resolveImportConfig(
  get: (key: ImportConfigKey) => number | undefined,
): ImportConfig {
  const config: ImportConfig = {
    errorCap: get('IMPORT_ERROR_CAP') ?? IMPORT_CONFIG_DEFAULTS.errorCap,
    busyDelaySeconds:
      get('IMPORT_BUSY_DELAY_SECONDS') ??
      IMPORT_CONFIG_DEFAULTS.busyDelaySeconds,
    scanInactivityMs:
      get('IMPORT_SCAN_INACTIVITY_MS') ??
      IMPORT_CONFIG_DEFAULTS.scanInactivityMs,
    scanTotalMs:
      get('IMPORT_SCAN_TOTAL_MS') ?? IMPORT_CONFIG_DEFAULTS.scanTotalMs,
  };
  const problems: string[] = [];
  const positive = (key: ImportConfigKey, value: number) => {
    if (!Number.isInteger(value) || value < 1)
      problems.push(`${key} must be a positive integer`);
  };
  positive('IMPORT_ERROR_CAP', config.errorCap);
  positive('IMPORT_BUSY_DELAY_SECONDS', config.busyDelaySeconds);
  positive('IMPORT_SCAN_INACTIVITY_MS', config.scanInactivityMs);
  positive('IMPORT_SCAN_TOTAL_MS', config.scanTotalMs);
  if (config.busyDelaySeconds > 900)
    problems.push(
      'IMPORT_BUSY_DELAY_SECONDS must be <= 900 (the queue maximum)',
    );
  if (config.scanTotalMs < config.scanInactivityMs)
    problems.push(
      'IMPORT_SCAN_TOTAL_MS must not be below IMPORT_SCAN_INACTIVITY_MS',
    );
  if (problems.length)
    throw new Error(`invalid import settings: ${problems.join('; ')}`);
  return config;
}

/** Object keys of the storage layout (data-model.md): built from ids only, never from client text. */
export const importSourceKey = (shopId: string, importId: string): string =>
  `imports/${shopId}/${importId}/source`;
export const importReportPartKey = (
  shopId: string,
  importId: string,
  batch: number,
): string =>
  `imports/${shopId}/${importId}/report/${String(batch).padStart(8, '0')}.csv`;
export const importReportKey = (shopId: string, importId: string): string =>
  `imports/${shopId}/${importId}/report/errors.csv`;
export const importReportPrefix = (shopId: string, importId: string): string =>
  `imports/${shopId}/${importId}/report/`;
export const importShopPrefix = (shopId: string): string =>
  `imports/${shopId}/`;
