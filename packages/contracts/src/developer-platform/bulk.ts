import { z } from 'zod';
import { PRODUCT_LIMITS } from '../catalog/index.ts';

/** S42 bulk stock, batch and the chunk message (contracts/http.md, contracts/events.md). */
const instant = z.iso.datetime({ offset: true });

export const BULK_LIMITS = {
  itemsMax: 10_000,
  syncItemsMax: 100,
  chunkSize: 100,
  operationId: { min: 1, max: 128 },
  failuresKept: 1_000,
  retentionDays: 7,
} as const;

export const BULK_JOB_ID = /^bsu_[0-9a-f]{32}$/;

export const bulkStockItemSchema = z
  .object({
    operationId: z
      .string()
      .min(BULK_LIMITS.operationId.min)
      .max(BULK_LIMITS.operationId.max),
    productId: z.string().uuid(),
    delta: z
      .number()
      .int()
      .refine((d) => d !== 0 && Math.abs(d) <= PRODUCT_LIMITS.stockDelta.max, {
        message: 'delta must be a non-zero integer with |delta| <= 1,000,000',
      }),
  })
  .strict();
export type BulkStockItem = z.infer<typeof bulkStockItemSchema>;

export const bulkStockRequestSchema = z
  .object({
    items: z
      .array(bulkStockItemSchema)
      .min(1)
      .max(BULK_LIMITS.itemsMax)
      .refine(
        (items) =>
          new Set(items.map((i) => i.operationId)).size === items.length,
        { message: 'operationId must be unique within the request' },
      ),
  })
  .strict();

/** `not_applied`: valid, but another item of the same all-or-nothing call was refused. `conflict`: anything else the stock service refuses. */
export const BULK_OUTCOMES = [
  'applied',
  'replayed',
  'not_found',
  'insufficient_stock',
  'not_applied',
  'conflict',
] as const;
export const bulkOutcomeSchema = z.enum(BULK_OUTCOMES);
export type BulkOutcome = z.infer<typeof bulkOutcomeSchema>;

export const bulkItemResultSchema = z.object({
  operation_id: z.string(),
  product_id: z.string(),
  outcome: bulkOutcomeSchema,
  stock_after: z.number().int().optional(),
});

export const bulkStockSyncResultSchema = z.object({
  object: z.literal('bulk_stock_update'),
  status: z.enum(['succeeded', 'failed', 'partially_failed']),
  results: z.array(bulkItemResultSchema),
});

export const bulkStockAcceptedSchema = z.object({
  object: z.literal('bulk_stock_update'),
  id: z.string().regex(BULK_JOB_ID),
  status: z.literal('processing'),
  total: z.number().int(),
  chunks: z.number().int(),
});

export const bulkStockJobSchema = z.object({
  object: z.literal('bulk_stock_update'),
  id: z.string().regex(BULK_JOB_ID),
  status: z.enum(['processing', 'succeeded', 'partially_failed', 'failed']),
  total: z.number().int(),
  applied: z.number().int(),
  replayed: z.number().int(),
  failed: z.number().int(),
  failures: z.array(bulkItemResultSchema).max(BULK_LIMITS.failuresKept),
  completed_chunks: z.number().int(),
  created_at: instant,
});

/** Body of the `public-api-bulk-chunk` queue. */
export const bulkChunkMessageSchema = z.object({
  jobId: z.string().regex(BULK_JOB_ID),
  shopId: z.string().uuid(),
  index: z.number().int().min(0),
  items: z.array(bulkStockItemSchema).min(1).max(BULK_LIMITS.chunkSize),
});
export type BulkChunkMessage = z.infer<typeof bulkChunkMessageSchema>;

export const BATCH_LIMITS = { operationsMax: 50, budgetMs: 10_000 } as const;

export const batchOperationSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PATCH']),
    path: z.string().min(1).max(512),
    body: z.unknown().optional(),
    ifMatch: z.string().max(64).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .strict();

export const batchRequestSchema = z
  .object({
    operations: z
      .array(batchOperationSchema)
      .min(1)
      .max(BATCH_LIMITS.operationsMax),
  })
  .strict();

export const batchResultSchema = z.object({
  object: z.literal('batch'),
  results: z.array(
    z.object({
      status: z.number().int(),
      body: z.unknown(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
