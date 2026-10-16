import { z } from 'zod';

/**
 * S20 same-day courier delivery (specs/domains/S20-courier-delivery/contracts/delivery-api.md and events.md). Requests
 * are strict (unknown fields are refused, V.4); responses stay open to additive fields (V.7): consumers read only the
 * keys named here. The event envelope and `defineEvent` live in the backend; this file holds the payload schemas.
 */

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const CITY_PATTERN = /^[a-z0-9-]{2,40}$/;
export const COURIER_VEHICLES = ['bike', 'scooter', 'car'] as const;
export const COURIER_STATUSES = ['OFFLINE', 'AVAILABLE', 'BUSY'] as const;
export const DELIVERY_STATUSES = [
  'REQUESTED',
  'OFFERED',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
] as const;
/** Statuses that publish `delivery.status_changed` (offer churn does not). */
export const DELIVERY_MILESTONES = [
  'REQUESTED',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
] as const;
export const DELIVERY_ACTOR_KINDS = [
  'courier',
  'shop',
  'system',
  'order',
] as const;

export const citySchema = z.string().regex(CITY_PATTERN);
export const courierVehicleSchema = z.enum(COURIER_VEHICLES);
export const courierStatusSchema = z.enum(COURIER_STATUSES);
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type CourierVehicle = z.infer<typeof courierVehicleSchema>;
export type CourierStatus = z.infer<typeof courierStatusSchema>;
export type DeliveryStatusValue = z.infer<typeof deliveryStatusSchema>;

export const geoPointSchema = z.object({ lat: latitude, lng: longitude });
export type GeoPoint = z.infer<typeof geoPointSchema>;
const strictGeoPointSchema = geoPointSchema.strict();

// ---------------------------------------------------------------- courier

export const courierSchema = z.object({
  id: z.string(),
  city: citySchema,
  vehicle: courierVehicleSchema,
  status: courierStatusSchema,
});
export type CourierView = z.infer<typeof courierSchema>;

export const courierOfferViewSchema = z.object({
  deliveryId: z.string(),
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  feeMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  expiresAt: z.string(),
});
export type CourierOfferView = z.infer<typeof courierOfferViewSchema>;

/** `GET /couriers/me`: the profile, the offer only while live, the active delivery. */
export const courierSelfSchema = courierSchema.extend({
  currentOffer: courierOfferViewSchema.optional(),
  activeDelivery: z
    .object({ deliveryId: z.string(), status: deliveryStatusSchema })
    .optional(),
});
export type CourierSelf = z.infer<typeof courierSelfSchema>;

export const registerCourierRequestSchema = z
  .object({ city: citySchema, vehicle: courierVehicleSchema })
  .strict();
export type RegisterCourierRequest = z.infer<
  typeof registerCourierRequestSchema
>;

export const availabilityRequestSchema = z
  .object({ available: z.boolean() })
  .strict();
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;

export const MAX_LOCATION_POINTS = 20;
export const MAX_LOCATION_BODY_BYTES = 32 * 1024;

export const locationPointSchema = z
  .object({
    lat: latitude,
    lng: longitude,
    ts: z.number().int().positive(),
    accuracy: z.number().min(0).max(10_000).optional(),
  })
  .strict();
export type LocationPoint = z.infer<typeof locationPointSchema>;

export const locationBatchRequestSchema = z
  .object({
    points: z.array(locationPointSchema).min(1).max(MAX_LOCATION_POINTS),
  })
  .strict();
export type LocationBatchRequest = z.infer<typeof locationBatchRequestSchema>;

export const locationBatchResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  dropped: z.object({
    stale: z.number().int().nonnegative(),
    future: z.number().int().nonnegative(),
  }),
  applied: z.boolean(),
  reason: z.literal('off_shift').optional(),
});
export type LocationBatchResponse = z.infer<typeof locationBatchResponseSchema>;

// --------------------------------------------------------------- delivery

export const requestDeliveryRequestSchema = z
  .object({
    orderId: z.string().uuid(),
    city: citySchema,
    pickup: strictGeoPointSchema,
    dropoff: strictGeoPointSchema,
  })
  .strict();
export type RequestDeliveryRequest = z.infer<
  typeof requestDeliveryRequestSchema
>;

export const cancelDeliveryRequestSchema = z
  .object({ reason: z.string().min(1).max(200) })
  .strict();
export type CancelDeliveryRequest = z.infer<typeof cancelDeliveryRequestSchema>;

const money = {
  feeMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
};

/** Buyer view: no courier id, offer, attempt or version; a position only while `ASSIGNED|PICKED_UP`. */
export const deliveryBuyerViewSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: deliveryStatusSchema,
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  ...money,
  courier: z
    .object({
      vehicle: courierVehicleSchema,
      position: z
        .object({
          lat: latitude,
          lng: longitude,
          ts: z.number().int(),
          stale: z.boolean(),
        })
        .optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeliveryBuyerView = z.infer<typeof deliveryBuyerViewSchema>;

export const deliveryBuyerListSchema = z.object({
  items: z.array(deliveryBuyerViewSchema),
});
export type DeliveryBuyerList = z.infer<typeof deliveryBuyerListSchema>;

/** Courier view (assigned or offered courier): no buyer id. */
export const deliveryCourierViewSchema = z.object({
  id: z.string(),
  status: deliveryStatusSchema,
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  ...money,
  offerExpiresAt: z.string().optional(),
});
export type DeliveryCourierView = z.infer<typeof deliveryCourierViewSchema>;

export const deliveryHistoryEntrySchema = z.object({
  /** `null` for the creation row. */
  from: z.string().nullable(),
  to: deliveryStatusSchema,
  at: z.string(),
  actorKind: z.enum(DELIVERY_ACTOR_KINDS),
  detail: z.string().optional(),
});
export type DeliveryHistoryEntry = z.infer<typeof deliveryHistoryEntrySchema>;

/** Shop view: no courier id or coordinates; `history` only on the detail read. */
export const deliveryShopViewSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: deliveryStatusSchema,
  city: z.string(),
  pickup: geoPointSchema,
  dropoff: geoPointSchema,
  ...money,
  surge: z.number(),
  createdAt: z.string(),
  history: z.array(deliveryHistoryEntrySchema).optional(),
});
export type DeliveryShopView = z.infer<typeof deliveryShopViewSchema>;

export const deliveryPageSchema = z.object({
  items: z.array(deliveryShopViewSchema),
  nextCursor: z.string().nullable(),
});
export type DeliveryPage = z.infer<typeof deliveryPageSchema>;

// ---------------------------------------------------------------- events

/** `delivery.status_changed` v1: outbox, topic `delivery.events`, key `deliveryId`. */
export const deliveryStatusChangedPayloadSchema = z.object({
  deliveryId: z.string(),
  orderId: z.string(),
  shopId: z.string(),
  buyerId: z.string(),
  status: z.enum(DELIVERY_MILESTONES),
  previousStatus: z.string().nullable(),
  courierId: z.string().nullable(),
  reason: z.string().nullable(),
  feeMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  deliveryVersion: z.number().int().positive(),
});
export type DeliveryStatusChangedPayload = z.infer<
  typeof deliveryStatusChangedPayloadSchema
>;

/** `courier.locations_reported` v1: direct produce, topic `courier`, key = city. */
export const courierLocationsReportedPayloadSchema = z.object({
  courierId: z.string(),
  city: z.string(),
  deliveryId: z.string().nullable(),
  points: z.array(
    z.object({
      lat: latitude,
      lng: longitude,
      ts: z.number().int(),
      accuracy: z.number().optional(),
    }),
  ),
});
export type CourierLocationsReportedPayload = z.infer<
  typeof courierLocationsReportedPayloadSchema
>;

export const deliveryEventSchemas = {
  'delivery.status_changed': deliveryStatusChangedPayloadSchema,
  'courier.locations_reported': courierLocationsReportedPayloadSchema,
} as const;

/** SQS `delivery-offer-timeouts` body; `courierId = ''` means "retry dispatch". */
export const offerTimeoutMessageSchema = z.object({
  deliveryId: z.string().uuid(),
  city: z.string(),
  courierId: z.string(),
  attempt: z.number().int().nonnegative(),
  handBacks: z.number().int().nonnegative().optional(),
});
export type OfferTimeoutMessage = z.infer<typeof offerTimeoutMessageSchema>;
