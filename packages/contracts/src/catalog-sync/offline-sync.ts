import { z } from 'zod';
import { CATALOG_SYNC_AGGREGATE_TYPE } from './events.ts';

/**
 * S09 offline sync (specs/domains/S09-offline-sync/contracts/http-api.md). The request and response shapes of the
 * four routes, written before the code; every e2e spec parses its responses with them.
 */
export const SYNC_LIMITS = {
  opsPerPush: { min: 1, max: 500 },
  stockDelta: 100_000,
  stockCount: 1_000_000,
  title: { min: 1, max: 200 },
  description: { max: 10_000 },
  pullLimit: { min: 1, max: 500, default: 200 },
  conflictLimit: { min: 1, max: 100, default: 20 },
} as const;

export const SYNC_PROBLEM_CODES = [
  'validation_failed',
  'invalid_cursor',
  'payload_too_large',
  'resync_required',
  'conflict_not_open',
  'sync_unavailable',
] as const;

export const SYNC_OP_TYPES = [
  'stock.adjust',
  'stock.count',
  'product.update',
] as const;
export const SYNC_STOCK_REASONS = [
  'received',
  'sold',
  'damaged',
  'returned',
  'other',
] as const;
export const SYNC_FIELDS = ['title', 'description', 'priceMinor'] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];

export const SYNC_STATUSES = [
  'applied',
  'merged',
  'conflict',
  'rejected',
  'retry',
] as const;
export const SYNC_RESULT_CODES = [
  'invalid_op',
  'invalid_hlc',
  'hlc_node_mismatch',
  'clock_implausible',
  'op_expired',
  'op_id_reused',
  'unknown_product',
  'product_unavailable',
  'invalid_field',
  'in_flight',
  'contention',
  'deadline_exceeded',
] as const;
export type SyncResultCode = (typeof SYNC_RESULT_CODES)[number];
export const SYNC_CONFLICT_KINDS = ['oversold', 'quantity_limit'] as const;

/** `X-Device-Id`: 4 to 64 of letters, digits, `_` and `-`. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const opId = z.string().regex(UUID_V7_PATTERN, 'opId must be a UUIDv7');
const common = {
  opId,
  hlc: z.string().min(1).max(128),
  productId: z.string().uuid(),
};

export const syncOpSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('stock.adjust'),
      delta: z
        .number()
        .int()
        .min(-SYNC_LIMITS.stockDelta)
        .max(SYNC_LIMITS.stockDelta)
        .refine((d) => d !== 0, 'delta must not be zero'),
      reason: z.enum(SYNC_STOCK_REASONS),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('stock.count'),
      counted: z.number().int().min(0).max(SYNC_LIMITS.stockCount),
      base: z.number().int().min(0).max(SYNC_LIMITS.stockCount),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('product.update'),
      fields: z
        .object({
          title: z
            .string()
            .min(SYNC_LIMITS.title.min)
            .max(SYNC_LIMITS.title.max)
            .optional(),
          description: z.string().max(SYNC_LIMITS.description.max).optional(),
          priceMinor: z.number().int().min(0).optional(),
        })
        .strict()
        .refine((f) => Object.keys(f).length > 0, 'at least one field'),
    })
    .strict(),
]);
export type SyncOp = z.infer<typeof syncOpSchema>;

/** What a device sends. */
export const syncPushRequestSchema = z
  .object({
    ops: z
      .array(syncOpSchema)
      .min(SYNC_LIMITS.opsPerPush.min)
      .max(SYNC_LIMITS.opsPerPush.max),
  })
  .strict();
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

/** What the server checks first: the envelope. Each operation is validated alone so one bad one never fails the batch. */
export const syncPushEnvelopeSchema = z
  .object({
    ops: z
      .array(z.unknown())
      .min(SYNC_LIMITS.opsPerPush.min)
      .max(SYNC_LIMITS.opsPerPush.max),
  })
  .strict();

export const syncConflictNumbersSchema = z
  .object({
    kind: z.enum(SYNC_CONFLICT_KINDS),
    requested: z.number().int(),
    applied: z.number().int(),
    shortfall: z.number().int(),
  })
  .strict();

export const syncOpResultSchema = z
  .object({
    index: z.number().int().min(0),
    /** Null only for an operation whose id could not be read. */
    opId: z.string().nullable(),
    status: z.enum(SYNC_STATUSES),
    replayed: z.boolean(),
    code: z.enum(SYNC_RESULT_CODES).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
    quantityAfter: z.number().int().optional(),
    productVersion: z.number().int().optional(),
    applied: z.array(z.enum(SYNC_FIELDS)).optional(),
    superseded: z.array(z.enum(SYNC_FIELDS)).optional(),
    conflict: syncConflictNumbersSchema.optional(),
  })
  .strict();
export type SyncOpResult = z.infer<typeof syncOpResultSchema>;

export const syncPushResponseSchema = z
  .object({ results: z.array(syncOpResultSchema), serverHlc: z.string() })
  .strict();
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

export const syncChangeDataSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    priceMinor: z.number().int(),
    currency: z.string(),
    quantity: z.number().int(),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
  })
  .strict();
export type SyncChangeData = z.infer<typeof syncChangeDataSchema>;

export const syncChangeSchema = z
  .object({
    seq: z.number().int().positive(),
    entity: z.literal('product'),
    id: z.string().uuid(),
    version: z.number().int().positive(),
    deleted: z.boolean(),
    data: syncChangeDataSchema.nullable(),
  })
  .strict();
export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncPullResponseSchema = z
  .object({
    changes: z.array(syncChangeSchema),
    cursor: z.string(),
    hasMore: z.boolean(),
    serverHlc: z.string(),
  })
  .strict();
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

export const syncPullQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(SYNC_LIMITS.pullLimit.min)
      .max(SYNC_LIMITS.pullLimit.max)
      .default(SYNC_LIMITS.pullLimit.default),
  })
  .strict();

export const syncConflictSchema = z
  .object({
    opId: z.string(),
    deviceId: z.string(),
    productId: z.string().uuid(),
    kind: z.enum(SYNC_CONFLICT_KINDS),
    requested: z.number().int(),
    applied: z.number().int(),
    shortfall: z.number().int(),
    quantityAfter: z.number().int(),
    status: z.enum(['open', 'dismissed']),
    createdAt: z.string(),
    dismissedAt: z.string().optional(),
    dismissedBy: z.string().optional(),
  })
  .strict();
export type SyncConflict = z.infer<typeof syncConflictSchema>;

export const syncConflictPageSchema = z
  .object({
    items: z.array(syncConflictSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type SyncConflictPage = z.infer<typeof syncConflictPageSchema>;

export const syncConflictListQuerySchema = z
  .object({
    status: z.enum(['open', 'dismissed']).default('open'),
    limit: z.coerce
      .number()
      .int()
      .min(SYNC_LIMITS.conflictLimit.min)
      .max(SYNC_LIMITS.conflictLimit.max)
      .default(SYNC_LIMITS.conflictLimit.default),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * `catalog_sync.offline_conflict_opened` v1. The S53 topic pattern allows no `-` in a topic name and no `_` in the first
 * segment of a type, so the spec's `catalog-sync.events` / `catalog_sync.*` are `catalogsync.events` /
 * `catalogsync.*` here, as for the S08 events (recorded in gaps.md).
 */
export const offlineConflictOpenedPayloadSchema = z
  .object({
    opId: z.string(),
    shopId: z.string().uuid(),
    deviceId: z.string(),
    productId: z.string().uuid(),
    kind: z.enum(SYNC_CONFLICT_KINDS),
    requested: z.number().int(),
    applied: z.number().int(),
    shortfall: z.number().int(),
    quantityAfter: z.number().int(),
  })
  .strict();

export const syncEventSchemas = {
  'catalogsync.offline_conflict_opened': z.object({
    eventId: z.string(),
    version: z.literal(1),
    aggregateType: z.literal(CATALOG_SYNC_AGGREGATE_TYPE),
    occurredAt: z.string(),
    aggregateId: z.string(),
    aggregateVersion: z.number().int().min(0),
    type: z.literal('catalogsync.offline_conflict_opened'),
    payload: offlineConflictOpenedPayloadSchema,
  }),
} as const;
