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
export const pickupOpeningHoursSchema = z.union([
  z.object({}).strict(),
  z.object({
    timezone: z.string().min(1),
    weekly: z.object({
      mon: day,
      tue: day,
      wed: day,
      thu: day,
      fri: day,
      sat: day,
      sun: day,
    }),
  }),
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
