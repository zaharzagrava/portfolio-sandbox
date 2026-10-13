import { z } from 'zod';

/**
 * S19 public pickup reads (specs/domains/S19-pickup-near-me/spec.md, Cross-capability contracts). Responses stay open
 * to additive fields (V.7): consumers read only the keys named here.
 */

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dayIntervalSchema = z.object({ open: hhmm, close: hhmm });
const day = z.array(dayIntervalSchema).max(3).optional();

/** `{}` (unknown) or `{timezone, weekly: {mon..sun: [{open, close}]}}` (S19 FR-002). */
const weeklySchema = z
  .object({
    mon: day,
    tue: day,
    wed: day,
    thu: day,
    fri: day,
    sat: day,
    sun: day,
  })
  .strict();
export const pickupOpeningHoursSchema = z.union([
  z.object({}).strict(),
  z.object({ timezone: z.string().min(1), weekly: weeklySchema }).strict(),
]);
export type PickupOpeningHours = z.infer<typeof pickupOpeningHoursSchema>;

/** `GET /search/near`: one hit per product with its nearest pickup point. */
export const pickupNearItemSchema = z.object({
  productId: z.string(),
  title: z.string(),
  category: z.string().optional(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  nearest: z.object({
    pickupPointId: z.string(),
    name: z.string().optional(),
    distanceM: z.number().int().nonnegative(),
    quantity: z.number().int().positive(),
  }),
});
export type PickupNearItem = z.infer<typeof pickupNearItemSchema>;

export const pickupNearSearchResponseSchema = z.object({
  items: z.array(pickupNearItemSchema),
  nextCursor: z.string().nullable(),
});
export type PickupNearSearchResponse = z.infer<
  typeof pickupNearSearchResponseSchema
>;

/** `GET /pickup-points/near`. `quantity` is present when `productId` was given. */
export const pickupPointNearSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: latitude,
  lng: longitude,
  distanceM: z.number().int().nonnegative(),
  openingHours: pickupOpeningHoursSchema,
  quantity: z.number().int().nonnegative().optional(),
});
export type PickupPointNear = z.infer<typeof pickupPointNearSchema>;

export const pickupPointsNearResponseSchema = z.object({
  items: z.array(pickupPointNearSchema),
  nextCursor: z.string().nullable(),
});
export type PickupPointsNearResponse = z.infer<
  typeof pickupPointsNearResponseSchema
>;

/** `GET /pickup-points/clusters`: map cells in the viewport; `pickupPointId` only when the cell holds one point. */
export const pickupClusterCellSchema = z.object({
  cellId: z.string().min(1),
  offers: z.number().int().nonnegative(),
  pickupPoints: z.number().int().positive(),
  lat: latitude,
  lng: longitude,
  pickupPointId: z.string().optional(),
});
export type PickupClusterCell = z.infer<typeof pickupClusterCellSchema>;

export const pickupClustersResponseSchema = z.object({
  cells: z.array(pickupClusterCellSchema),
  truncated: z.boolean(),
});
export type PickupClustersResponse = z.infer<
  typeof pickupClustersResponseSchema
>;

/* ---------------------------------------------------------------- limits and queries (S19 FR-022, FR-026) */

export const PICKUP_LIMITS = {
  radiusKm: { min: 0.1, max: 50, default: 5 },
  limit: { min: 1, max: 50, default: 20 },
  zoom: { min: 0, max: 20, default: 10 },
  qMax: 100,
  cursorMax: 512,
  pointsPerShop: 100,
  stockMax: 1_000_000,
  deltaMax: 100_000,
  nameMax: 120,
  addressMax: 300,
} as const;

const DECIMAL = /^-?\d{1,3}(\.\d{1,12})?$/;
const decimal = (min: number, max: number) =>
  z
    .string()
    .regex(DECIMAL)
    .transform(Number)
    .refine((n) => Number.isFinite(n) && n >= min && n <= max);
const lat = decimal(-90, 90);
const lng = decimal(-180, 180);
const radiusKm = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,3})?$/)
  .transform(Number)
  .refine(
    (n) => n >= PICKUP_LIMITS.radiusKm.min && n <= PICKUP_LIMITS.radiusKm.max,
  )
  .default(PICKUP_LIMITS.radiusKm.default);
const limit = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .refine((n) => n >= PICKUP_LIMITS.limit.min && n <= PICKUP_LIMITS.limit.max)
  .default(PICKUP_LIMITS.limit.default);
const cursor = z.string().min(1).max(PICKUP_LIMITS.cursorMax).optional();
/** Blank (spaces only) means absent; longer than 100 characters is refused, never cut. */
const q = z
  .string()
  .max(PICKUP_LIMITS.qMax)
  .transform((s) => s.trim())
  .transform((s) => (s === '' ? undefined : s))
  .optional();
const uuid = z.string().uuid();

/** `GET /search/near` */
export const pickupSearchQuerySchema = z
  .object({ lat, lng, radiusKm, q, limit, cursor })
  .strict();
export type PickupSearchQuery = z.infer<typeof pickupSearchQuerySchema>;

/** `GET /pickup-points/near` */
export const pickupBrowseQuerySchema = z
  .object({ lat, lng, radiusKm, productId: uuid.optional(), limit, cursor })
  .strict();
export type PickupBrowseQuery = z.infer<typeof pickupBrowseQuerySchema>;

/** `top,left,bottom,right`: four numbers, `top > bottom`; `left > right` crosses the antimeridian. */
const bbox = z
  .string()
  .transform((s) => s.split(','))
  .refine((parts) => parts.length === 4 && parts.every((p) => DECIMAL.test(p)))
  .transform(([top, left, bottom, right]) => ({
    top: Number(top),
    left: Number(left),
    bottom: Number(bottom),
    right: Number(right),
  }))
  .refine(
    (b) =>
      Math.abs(b.top) <= 90 &&
      Math.abs(b.bottom) <= 90 &&
      Math.abs(b.left) <= 180 &&
      Math.abs(b.right) <= 180 &&
      b.top > b.bottom,
  );
const zoom = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform(Number)
  .refine((n) => n >= PICKUP_LIMITS.zoom.min && n <= PICKUP_LIMITS.zoom.max)
  .default(PICKUP_LIMITS.zoom.default);

/** `GET /pickup-points/clusters` */
export const pickupClusterQuerySchema = z
  .object({ bbox, zoom, productId: uuid.optional() })
  .strict();
export type PickupClusterQuery = z.infer<typeof pickupClusterQuerySchema>;

/** Seller list query (`GET /shops/:shopId/pickup-points[/:pointId/stock]`). */
export const pickupListQuerySchema = z.object({ limit, cursor }).strict();
export type PickupListQuery = z.infer<typeof pickupListQuerySchema>;

/* ---------------------------------------------------------------- seller bodies and responses (S19 FR-001..FR-014) */

const name = z.string().trim().min(1).max(PICKUP_LIMITS.nameMax);
const address = z.string().trim().min(1).max(PICKUP_LIMITS.addressMax);

export const pickupPointCreateSchema = z
  .object({
    name,
    address,
    lat: latitude,
    lng: longitude,
    openingHours: pickupOpeningHoursSchema.optional(),
  })
  .strict();
export type PickupPointCreate = z.infer<typeof pickupPointCreateSchema>;

/** `lat`, `lng` and `shopId` are unknown keys on purpose: a point never moves. */
export const pickupPointPatchSchema = z
  .object({
    name: name.optional(),
    address: address.optional(),
    openingHours: pickupOpeningHoursSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0);
export type PickupPointPatch = z.infer<typeof pickupPointPatchSchema>;

export const pickupPointSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: latitude,
  lng: longitude,
  openingHours: pickupOpeningHoursSchema,
  active: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PickupPoint = z.infer<typeof pickupPointSchema>;

export const pickupPointPageSchema = z.object({
  items: z.array(pickupPointSchema),
  nextCursor: z.string().nullable(),
});
export type PickupPointPage = z.infer<typeof pickupPointPageSchema>;

export const pickupStockSetSchema = z
  .object({
    quantity: z.number().int().min(0).max(PICKUP_LIMITS.stockMax),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type PickupStockSet = z.infer<typeof pickupStockSetSchema>;

export const pickupStockAdjustSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-PICKUP_LIMITS.deltaMax)
      .max(PICKUP_LIMITS.deltaMax)
      .refine((n) => n !== 0),
  })
  .strict();
export type PickupStockAdjust = z.infer<typeof pickupStockAdjustSchema>;

export const pickupStockSchema = z.object({
  pickupPointId: z.string(),
  productId: z.string(),
  quantity: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export type PickupStock = z.infer<typeof pickupStockSchema>;

export const pickupStockAdjustedSchema = pickupStockSchema.extend({
  applied: z.literal(true),
});
export type PickupStockAdjusted = z.infer<typeof pickupStockAdjustedSchema>;

export const pickupStockRowSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export const pickupStockPageSchema = z.object({
  items: z.array(pickupStockRowSchema),
  nextCursor: z.string().nullable(),
});
export type PickupStockPage = z.infer<typeof pickupStockPageSchema>;

/* ---------------------------------------------------------------- events (topic `pickup.events`) */

export const pickupStockChangedPayloadSchema = z.object({
  pickupPointId: z.string(),
  productId: z.string(),
  shopId: z.string(),
  quantity: z.number().int().min(0),
  stockVersion: z.number().int().positive(),
  lat: latitude,
  lng: longitude,
});
export type PickupStockChangedPayload = z.infer<
  typeof pickupStockChangedPayloadSchema
>;

export const pickupPointChangedPayloadSchema = z.object({
  pickupPointId: z.string(),
  shopId: z.string(),
  name: z.string(),
  address: z.string(),
  lat: latitude,
  lng: longitude,
  active: z.boolean(),
  pointVersion: z.number().int().positive(),
});
export type PickupPointChangedPayload = z.infer<
  typeof pickupPointChangedPayloadSchema
>;
