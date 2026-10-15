import { z } from 'zod';
import { validateScheduleInput } from '@app/infrastructure/jobs/schedule-validation';

/**
 * Settings of the statements (specs/domains/S16-seller-statements/contracts/config.md). Read once at module
 * initialisation; a value outside its range fails startup naming the key (AS-79). No secrets.
 */
const int = (fallback: number, min: number, max?: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? fallback : Number(v)),
    max === undefined
      ? z.number().int().min(min)
      : z.number().int().min(min).max(max),
  );

export const statementsConfigSchema = z
  .object({
    STATEMENTS_SNAPSHOT_BATCH: int(10_000, 1, 10_000),
    STATEMENTS_ADJUSTMENT_SHOP_BATCH: int(1000, 1, 1000),
    STATEMENTS_EXPORT_BATCH: int(1000, 1, 5000),
    STATEMENTS_CLOSE_MARGIN_MIN: int(10, 0),
    STATEMENTS_EXPORT_CONCURRENCY: int(2, 1),
    STATEMENTS_EXPORT_TIMEOUT_MS: int(120_000, 1000),
    STATEMENTS_JOB_TIMEOUT_MS: int(600_000, 1000),
    STATEMENTS_CLOSE_SCHEDULE: z.string().default('0 2 2 * *'),
    STATEMENTS_CLOSE_SCHEDULE_TZ: z.string().default('UTC'),
    STATEMENTS_RETENTION_YEARS: int(10, 10),
    STATEMENTS_LEDGER_GRACE_HOURS: int(24, 1),
    STATEMENTS_DRAIN_MS: int(30_000, 1000),
  })
  .superRefine((value, ctx) => {
    try {
      validateScheduleInput({
        name: 'statements.close-month',
        cron: value.STATEMENTS_CLOSE_SCHEDULE,
        timezone: value.STATEMENTS_CLOSE_SCHEDULE_TZ,
      });
    } catch (error) {
      const field = (error as { field?: string }).field;
      ctx.addIssue({
        code: 'custom',
        path: [
          field === 'timezone'
            ? 'STATEMENTS_CLOSE_SCHEDULE_TZ'
            : 'STATEMENTS_CLOSE_SCHEDULE',
        ],
        message: 'invalid schedule',
      });
    }
  });

export interface StatementsConfig {
  snapshotBatch: number;
  adjustmentShopBatch: number;
  exportBatch: number;
  closeMarginMin: number;
  exportConcurrency: number;
  exportTimeoutMs: number;
  jobTimeoutMs: number;
  closeSchedule: string;
  closeScheduleTz: string;
  retentionYears: number;
  ledgerGraceHours: number;
  drainMs: number;
}

export const STATEMENTS_CONFIG = Symbol('STATEMENTS_CONFIG');

/** Parses the environment; the error names every offending key and never a value. */
export function loadStatementsConfig(
  env: Record<string, string | undefined> = process.env,
): StatementsConfig {
  const parsed = statementsConfigSchema.safeParse(env);
  if (!parsed.success) {
    const keys = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(`Invalid statements configuration: ${keys.join(', ')}`);
  }
  const v = parsed.data;
  return {
    snapshotBatch: v.STATEMENTS_SNAPSHOT_BATCH,
    adjustmentShopBatch: v.STATEMENTS_ADJUSTMENT_SHOP_BATCH,
    exportBatch: v.STATEMENTS_EXPORT_BATCH,
    closeMarginMin: v.STATEMENTS_CLOSE_MARGIN_MIN,
    exportConcurrency: v.STATEMENTS_EXPORT_CONCURRENCY,
    exportTimeoutMs: v.STATEMENTS_EXPORT_TIMEOUT_MS,
    jobTimeoutMs: v.STATEMENTS_JOB_TIMEOUT_MS,
    closeSchedule: v.STATEMENTS_CLOSE_SCHEDULE,
    closeScheduleTz: v.STATEMENTS_CLOSE_SCHEDULE_TZ,
    retentionYears: v.STATEMENTS_RETENTION_YEARS,
    ledgerGraceHours: v.STATEMENTS_LEDGER_GRACE_HOURS,
    drainMs: v.STATEMENTS_DRAIN_MS,
  };
}

export const statementsConfigProvider = {
  provide: STATEMENTS_CONFIG,
  useFactory: (): StatementsConfig => loadStatementsConfig(),
};
