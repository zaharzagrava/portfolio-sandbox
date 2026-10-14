import { z } from 'zod';

/** S11 flash sales (specs/domains/S11-flash-sales/contracts/http.md). Money is integer minor units. */

const instant = z.iso.datetime({ offset: true });
const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 3_600_000;

export const FLASH_SALE_STATUSES = [
  'SCHEDULED',
  'LOADED',
  'ENDED',
  'RECONCILED',
  'CANCELLED',
  'START_FAILED',
] as const;
export const flashSaleStatusSchema = z.enum(FLASH_SALE_STATUSES);
export type FlashSaleStatusValue = z.infer<typeof flashSaleStatusSchema>;

export const FLASH_STATUS_REASONS = [
  'insufficient_stock',
  'window_missed',
  'cancelled_by_shop',
  'product_unavailable',
] as const;
export const flashStatusReasonSchema = z.enum(FLASH_STATUS_REASONS);

export const FLASH_DEFAULT_BUCKETS = 16;
export const FLASH_DEFAULT_PER_USER_LIMIT = 2;
export const FLASH_DEFAULT_ADMISSION_RATE = 2000;
export const FLASH_PAGE_DEFAULT_LIMIT = 20;
export const FLASH_PAGE_MAX_LIMIT = 100;
export const FLASH_BATCH_MAX_PRODUCTS = 100;

/**
 * `POST /shops/:shopId/flash-sales`. Strict: unknown properties are refused (`shopId` comes from the path). The
 * clock rules (start at least 2 minutes ahead) are checked by the service; the shape rules are here.
 */
export const flashSaleCreateRequestSchema = z
  .object({
    productId: z.string().uuid(),
    priceMinor: z.number().int().min(1).max(MAX_MINOR),
    units: z.number().int().min(1).max(1_000_000),
    buckets: z.number().int().min(1).max(256).optional(),
    perUserLimit: z.number().int().min(1).max(20).optional(),
    admissionRatePerSecond: z.number().int().min(1).max(10_000).optional(),
    startsAt: instant,
    endsAt: instant,
  })
  .strict()
  .superRefine((value, ctx) => {
    const start = Date.parse(value.startsAt);
    const end = Date.parse(value.endsAt);
    if (end <= start)
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    else if (end - start > DAY_MS)
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'the window must not exceed 24 hours',
      });
    if (value.perUserLimit !== undefined && value.perUserLimit > value.units)
      ctx.addIssue({
        code: 'custom',
        path: ['perUserLimit'],
        message: 'perUserLimit must not exceed units',
      });
  })
  .transform((value) => ({
    ...value,
    buckets: value.buckets ?? FLASH_DEFAULT_BUCKETS,
    // The stored limit may not exceed the units, so the default shrinks for a tiny drop.
    perUserLimit:
      value.perUserLimit ?? Math.min(FLASH_DEFAULT_PER_USER_LIMIT, value.units),
    admissionRatePerSecond:
      value.admissionRatePerSecond ?? FLASH_DEFAULT_ADMISSION_RATE,
  }));
export type FlashSaleCreateRequest = z.infer<
  typeof flashSaleCreateRequestSchema
>;

export const flashSaleStatsSchema = z
  .object({
    unitsLoaded: z.number().int().nonnegative(),
    unitsRemaining: z.number().int().nonnegative(),
    unitsHeld: z.number().int().nonnegative(),
    unitsSold: z.number().int().nonnegative(),
  })
  .strict();

/** Seller view of one sale; `stats` is `null` while `SCHEDULED`, `CANCELLED` and `START_FAILED`. */
export const flashSaleMemberSchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    productId: z.string().uuid(),
    priceMinor: z.number().int().min(1).max(MAX_MINOR),
    currency: z.string().regex(/^[A-Z]{3}$/),
    units: z.number().int().min(1),
    buckets: z.number().int().min(1).max(256),
    perUserLimit: z.number().int().min(1).max(20),
    admissionRatePerSecond: z.number().int().min(1).max(10_000),
    startsAt: instant,
    endsAt: instant,
    status: flashSaleStatusSchema,
    statusReason: flashStatusReasonSchema.nullable(),
    stats: flashSaleStatsSchema.nullable(),
    createdAt: instant,
  })
  .strict();
export type FlashSaleMember = z.infer<typeof flashSaleMemberSchema>;

export const flashSaleListQuerySchema = z
  .object({
    status: flashSaleStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(FLASH_PAGE_MAX_LIMIT)
      .default(FLASH_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type FlashSaleListQuery = z.infer<typeof flashSaleListQuerySchema>;

export const flashSalePageSchema = z
  .object({
    items: z.array(flashSaleMemberSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type FlashSalePage = z.infer<typeof flashSalePageSchema>;

export const flashPublicStateSchema = z.enum([
  'UPCOMING',
  'LIVE',
  'SOLD_OUT',
  'ENDED',
]);

/**
 * Anonymous view. Strict: no `units`, bucket count, admission rate, `shopId` or buyer data. `remainingApprox` is
 * `null` for `UPCOMING`, and with `degraded: true` when the stock store failed during `LIVE`.
 */
export const flashSalePublicSchema = z
  .object({
    saleId: z.string().uuid(),
    productId: z.string().uuid(),
    priceMinor: z.number().int().min(1).max(MAX_MINOR),
    currency: z.string().regex(/^[A-Z]{3}$/),
    perUserLimit: z.number().int().min(1).max(20),
    startsAt: instant,
    endsAt: instant,
    state: flashPublicStateSchema,
    remainingApprox: z.number().int().nonnegative().nullable(),
    degraded: z.literal(true).optional(),
    serverTime: instant,
  })
  .strict();
export type FlashSalePublic = z.infer<typeof flashSalePublicSchema>;

/** `GET /flash-sales?productIds=<uuid>,<uuid>`: at most one view per product. */
export const flashSalesResponseSchema = z.array(flashSalePublicSchema);
export type FlashSalesResponse = z.infer<typeof flashSalesResponseSchema>;

export const flashSaleProblemCodes = [
  'flash_sale_busy',
  'flash_sale_unavailable',
  'flash_sale_limit_exceeded',
  'flash_sale_not_found',
  'flash_sale_overlap',
  'flash_sale_not_cancellable',
] as const;
