import { z } from 'zod';

/** S07 bulk catalog import (specs/domains/S07-bulk-import/contracts/http-api.md and events-and-messages.md). */
export const IMPORT_STATUSES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'SCANNING',
  'PROCESSING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof importStatusSchema>;

export const IMPORT_MAX_BYTES = 5_368_709_120;
export const IMPORT_PART_BYTES = 67_108_864;

export const IMPORT_FAILURE_CODES = [
  'malware_detected',
  'scan_unavailable',
  'unsupported_file_type',
  'invalid_header',
  'malformed_file',
  'size_mismatch',
  'source_missing',
  'too_many_errors',
  'shop_not_active',
  'internal_error',
] as const;
export const importFailureCodeSchema = z.enum(IMPORT_FAILURE_CODES);
export type ImportFailureCode = z.infer<typeof importFailureCodeSchema>;

/** Fixed text per failure code: the raw error goes to the logs only. */
export const IMPORT_FAILURE_MESSAGES: Record<ImportFailureCode, string> = {
  malware_detected: 'The file was refused by the malware scan.',
  scan_unavailable: 'The file could not be scanned. Start the import again.',
  unsupported_file_type: 'The file is not a CSV or JSON-lines catalog.',
  invalid_header: 'The header row lacks a required column or repeats one.',
  malformed_file: 'The file could not be read past a malformed record.',
  size_mismatch: 'The uploaded file does not have the declared size.',
  source_missing: 'The uploaded file is no longer available.',
  too_many_errors: 'Too many rows were refused; the import was stopped.',
  shop_not_active: 'The shop is not active, so the import was stopped.',
  internal_error: 'The import failed. Start the import again.',
};

/** Problem `code`s of the import routes (http-api.md). */
export const IMPORT_PROBLEM_CODES = [
  'validation_failed',
  'idempotency_key_required',
  'idempotency_key_invalid',
  'idempotency_key_reuse',
  'idempotency_in_flight',
  'import_not_found',
  'invalid_parts',
  'size_mismatch',
  'import_not_uploadable',
  'import_not_completable',
  'import_not_cancellable',
  'import_error_report_not_found',
  'error_report_not_ready',
  'too_many_active_imports',
  'rate_limited',
  'shop_suspended',
  'shop_offboarding',
] as const;
export type ImportProblemCode = (typeof IMPORT_PROBLEM_CODES)[number];

const count = z.number().int().nonnegative();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const importStartRequestSchema = z.strictObject({
  fileName: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !CONTROL.test(v), 'control characters are not allowed'),
  sizeBytes: z.number().int().min(1).max(IMPORT_MAX_BYTES),
});
export type ImportStartRequest = z.infer<typeof importStartRequestSchema>;

const partUrl = z.strictObject({
  partNumber: z.number().int().min(1),
  url: z.string().min(1),
});

export const importStartResponseSchema = z.strictObject({
  importId: z.string().uuid(),
  status: z.literal('PENDING_UPLOAD'),
  partSize: z.number().int().positive(),
  partCount: z.number().int().min(1),
  parts: z.array(partUrl),
  uploadExpiresAt: z.string().datetime(),
});
export type ImportStartResponse = z.infer<typeof importStartResponseSchema>;

export const importUploadStateSchema = z.strictObject({
  importId: z.string().uuid(),
  partSize: z.number().int().positive(),
  partCount: z.number().int().min(1),
  uploaded: z.array(
    z.strictObject({
      partNumber: z.number().int().min(1),
      etag: z.string(),
      sizeBytes: count,
    }),
  ),
  missing: z.array(partUrl),
  uploadExpiresAt: z.string().datetime(),
});
export type ImportUploadState = z.infer<typeof importUploadStateSchema>;

/**
 * Only the shape is checked here. An empty list, a part number outside `1..partCount`, a repeated or misordered part
 * and an empty or unknown ETag are `422 invalid_parts` (S07 AS-08), decided against what storage holds.
 */
export const importCompleteRequestSchema = z.strictObject({
  parts: z.array(
    z.strictObject({
      partNumber: z.number().int(),
      etag: z.string(),
    }),
  ),
});
export type ImportCompleteRequest = z.infer<typeof importCompleteRequestSchema>;

const jobFields = {
  id: z.string().uuid(),
  shopId: z.string().uuid(),
  status: importStatusSchema,
  fileName: z.string(),
  sizeBytes: count,
  rowsProcessed: count,
  rowsCreated: count,
  rowsUpdated: count,
  rowsUnchanged: count,
  rowsFailed: count,
  bytesProcessed: count,
  ignoredColumns: z.array(z.string()),
  scan: z.enum(['clean', 'skipped']).nullable(),
  /** `message` is the fixed text of the code; `detail` is generic extra, such as the missing column names. */
  failure: z
    .strictObject({
      code: importFailureCodeSchema,
      message: z.string(),
      detail: z.string().nullable(),
    })
    .nullable(),
  errorReport: z.strictObject({ available: z.boolean(), rows: count }),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
};

/** Never carries the storage key, upload handle, link, lease, slot or scanner signature. */
export const importJobSchema = z.strictObject({
  ...jobFields,
  history: z.array(
    z.strictObject({ status: importStatusSchema, at: z.string().datetime() }),
  ),
});
export type ImportJob = z.infer<typeof importJobSchema>;

export const importJobSummarySchema = z.strictObject(jobFields);
export type ImportJobSummary = z.infer<typeof importJobSummarySchema>;

/** `GET /shops/:shopId/imports?status&limit&cursor`: `limit` 1-100 (default 20), the cursor is opaque. */
export const importListQuerySchema = z.strictObject({
  status: importStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
export type ImportListQuery = z.infer<typeof importListQuerySchema>;

export const importPageSchema = z.strictObject({
  items: z.array(importJobSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ImportPage = z.infer<typeof importPageSchema>;

export const importErrorReportSchema = z.strictObject({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  rows: count,
});
export type ImportErrorReport = z.infer<typeof importErrorReportSchema>;

/** Live topic `import:<importId>`. */
export const importProgressEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('progress'),
    processed: count,
    failed: count,
    bytesProcessed: count,
    sizeBytes: count,
  }),
  z.strictObject({
    type: z.literal('done'),
    rowsProcessed: count,
    rowsFailed: count,
  }),
  z.strictObject({ type: z.literal('failed'), code: importFailureCodeSchema }),
  z.strictObject({ type: z.literal('cancelled') }),
]);
export type ImportProgressEvent = z.infer<typeof importProgressEventSchema>;

/** The queue message of `catalog-imports`: only the import id. */
export const importMessageSchema = z.strictObject({
  importId: z.string().uuid(),
});
export type ImportMessage = z.infer<typeof importMessageSchema>;

/**
 * `catalogsync.import_finished` v1, key `importId`, on the shared topic `catalogsync.events`. The spec drafted
 * `catalog_sync.import_finished` on `catalog-sync.events`; the platform's patterns allow no `_` in the first segment of a
 * type nor `-` in an aggregate type (as for S08's events). Payload only; the envelope is the platform's.
 */
export const importEventSchemas = {
  'catalogsync.import_finished': z.strictObject({
    importId: z.string().uuid(),
    shopId: z.string().uuid(),
    createdBy: z.string().uuid(),
    status: z.enum(['DONE', 'FAILED', 'CANCELLED', 'EXPIRED']),
    failureCode: importFailureCodeSchema.nullable(),
    rowsProcessed: count,
    rowsCreated: count,
    rowsUpdated: count,
    rowsUnchanged: count,
    rowsFailed: count,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime(),
  }),
} as const;
