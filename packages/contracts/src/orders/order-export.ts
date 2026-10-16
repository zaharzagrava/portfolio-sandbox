import { z } from 'zod';

/** S12 order export (specs/domains/S12-order-export/contracts/http.md and async.md). */
export const EXPORT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export const orderExportStatusSchema = z.enum(EXPORT_STATUSES);
export type OrderExportStatus = z.infer<typeof orderExportStatusSchema>;

export const EXPORT_FAILURE_CODES = [
  'storage_unavailable',
  'catalog_unavailable',
  'database_unavailable',
  'row_limit_exceeded',
  'timeout',
  'shop_not_found',
  'attempts_exhausted',
  'internal_error',
] as const;
export const exportFailureCodeSchema = z.enum(EXPORT_FAILURE_CODES);
export type ExportFailureCode = (typeof EXPORT_FAILURE_CODES)[number];

/** Problem `code`s of the export routes (spec.md section Provides). */
export const ORDER_EXPORT_PROBLEM_CODES = [
  'validation_failed',
  'invalid_cursor',
  'idempotency_key_required',
  'idempotency_key_invalid',
  'idempotency_key_reuse',
  'idempotency_in_flight',
  'export_already_active',
  'export_not_found',
  'export_not_ready',
  'export_expired',
  'export_not_cancellable',
  'rate_limited',
  'permission_denied',
  'shop_not_found',
  'shop_suspended',
  'shop_offboarding',
] as const;
export type OrderExportProblemCode =
  (typeof ORDER_EXPORT_PROBLEM_CODES)[number];

export const orderExportCreateRequestSchema = z.strictObject({});
export type OrderExportCreateRequest = z.infer<
  typeof orderExportCreateRequestSchema
>;

const count = z.number().int().nonnegative();

export const orderExportSchema = z.strictObject({
  exportId: z.string().uuid(),
  status: orderExportStatusSchema,
  rowsWritten: count,
  totalRows: count.nullable(),
  bytesWritten: count,
  attempt: count,
  failure: z
    .strictObject({ code: exportFailureCodeSchema, message: z.string() })
    .nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
});
export type OrderExport = z.infer<typeof orderExportSchema>;

/** `GET /shops/:shopId/order-exports?status&limit&cursor`: `limit` 1-100 (default 20), the cursor is opaque. */
export const orderExportListQuerySchema = z.strictObject({
  status: orderExportStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
export type OrderExportListQuery = z.infer<typeof orderExportListQuerySchema>;

export const orderExportPageSchema =z.strictObject({
  items: z.array(orderExportSchema),
  nextCursor: z.string().nullable(),
});
export type OrderExportPage = z.infer<typeof orderExportPageSchema>;

export const orderExportDownloadSchema = z.strictObject({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type OrderExportDownload = z.infer<typeof orderExportDownloadSchema>;

/** Live topic `order-export:<exportId>`. */
export const orderExportProgressEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('progress'),
    rowsWritten: count,
    totalRows: count,
    bytesWritten: count,
  }),
  z.strictObject({
    type: z.literal('done'),
    rowsWritten: count,
    bytesWritten: count,
  }),
  z.strictObject({ type: z.literal('failed'), code: exportFailureCodeSchema }),
  z.strictObject({ type: z.literal('cancelled') }),
]);
export type OrderExportProgressEvent = z.infer<
  typeof orderExportProgressEventSchema
>;

/**
 * `orderexport.finished` v1: outbox, topic `order_exports.events`, key `exportId`. The platform's event-type pattern
 * allows no `_` in the first segment and its topic names no `-` (the spec drafted `order_export.finished` on
 * `order-exports.events`), as with S11's `flashsale.*`. As in `orderEventSchemas`, these are the payloads; the envelope
 * (`eventId`, `type`, `version`, `aggregateId`, `occurredAt`) is the platform's.
 */
export const orderExportEventSchemas = {
  'orderexport.finished': z.strictObject({
    exportId: z.string().uuid(),
    shopId: z.string().uuid(),
    createdBy: z.string().uuid(),
    status: z.enum(['DONE', 'FAILED', 'CANCELLED']),
    failureCode: z.string().nullable(),
    rowsWritten: count,
    bytesWritten: count,
    attempt: count,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime(),
  }),
} as const;
