import { z } from 'zod';

/** Launch-event booking contracts (S22 spec "Provides"). Dates are ISO strings on the wire. */

export const LAUNCH_EVENT_STATUSES = [
  'SCHEDULED',
  'ON_SALE',
  'SOLD_OUT',
  'CLOSED',
] as const;
export const HOLD_STATES = [
  'HELD',
  'CONFIRMING',
  'CONFIRMED',
  'RELEASED',
  'EXPIRED',
] as const;
export const SEATING_MODES = ['SEATED', 'GENERAL'] as const;

/** Error `code` vocabulary of the capability (FR-051) with the HTTP status of each. */
export const LAUNCH_EVENT_ERROR_STATUS = {
  ADMISSION_REQUIRED: 403,
  HUMAN_CHECK_FAILED: 403,
  EVENT_NOT_FOUND: 404,
  TICKET_NOT_FOUND: 404,
  HOLD_NOT_FOUND: 404,
  EVENT_NOT_ON_SALE: 409,
  EVENT_SOLD_OUT: 409,
  EVENT_CLOSED: 409,
  EVENT_ALREADY_CLOSED: 409,
  SEAT_TAKEN: 409,
  NO_SEATS_AVAILABLE: 409,
  HOLD_EXPIRED: 409,
  HOLD_RELEASED: 409,
  HOLD_ALREADY_CONFIRMED: 409,
  UNKNOWN_SEAT: 422,
  SEATS_NOT_SELECTABLE: 422,
  TICKET_LIMIT_EXCEEDED: 422,
  invalid_schedule: 422,
  WAITING_ROOM_FULL: 503,
  WAITING_ROOM_UNAVAILABLE: 503,
  HOLDS_UNAVAILABLE: 503,
} as const;
export type LaunchEventErrorCode = keyof typeof LAUNCH_EVENT_ERROR_STATUS;

const iso = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const launchEventSchema = z.object({
  id: uuid,
  shopId: uuid,
  title: z.string(),
  venue: z.string(),
  startsAt: iso,
  salesOpenAt: iso,
  seatCount: z.number().int(),
  seatsPerRow: z.number().int(),
  seatingMode: z.enum(SEATING_MODES),
  perUserLimit: z.number().int(),
  humanCheckRequired: z.boolean(),
  status: z.enum(LAUNCH_EVENT_STATUSES),
});
export type LaunchEventDto = z.infer<typeof launchEventSchema>;

export const createLaunchEventRequestSchema = z
  .object({
    title: z.string().min(1).max(120),
    venue: z.string().min(1).max(200),
    startsAt: iso,
    salesOpenAt: iso,
    seatCount: z.number().int().min(1).max(100_000),
    seatsPerRow: z.number().int().min(1).max(500).optional(),
    seatingMode: z.enum(SEATING_MODES).optional(),
    perUserLimit: z.number().int().min(1).max(10).optional(),
    admissionRatePerSec: z.number().int().min(1).max(100_000).optional(),
    humanCheckRequired: z.boolean().optional(),
  })
  .strict();
export type CreateLaunchEventRequest = z.infer<
  typeof createLaunchEventRequestSchema
>;

export const queueStatusSchema = z.object({
  ticket: uuid,
  admitted: z.boolean(),
  position: z.number().int().optional(),
  queueLength: z.number().int().optional(),
  etaSeconds: z.number().int().optional(),
  heartbeatSeconds: z.number().int(),
  expiresAt: iso,
  admissionToken: z.string().optional(),
  tokenExpiresAt: iso.optional(),
});
export type QueueStatusDto = z.infer<typeof queueStatusSchema>;

export const MAX_SEATS_PER_HOLD = 10;
export const holdSeatsRequestSchema = z.union([
  z
    .object({
      seats: z
        .array(z.number().int().min(0))
        .min(1)
        .max(MAX_SEATS_PER_HOLD),
    })
    .strict(),
  z
    .object({
      quantity: z.number().int().min(1).max(MAX_SEATS_PER_HOLD),
    })
    .strict(),
]);
export type HoldSeatsRequest = z.infer<typeof holdSeatsRequestSchema>;

export const holdSchema = z.object({
  holdId: uuid,
  eventId: uuid,
  seats: z.array(z.number().int()),
  expiresAt: iso,
  serverTime: iso,
  limit: z.object({
    perUser: z.number().int(),
    remaining: z.number().int(),
  }),
});
export type HoldDto = z.infer<typeof holdSchema>;

export const bookingRefSchema = z.object({
  bookingId: uuid,
  seat: z.number().int(),
});
export const confirmResponseSchema = z.object({
  holdId: uuid,
  eventId: uuid,
  bookings: z.array(bookingRefSchema),
  confirmedAt: iso,
});
export type ConfirmResponseDto = z.infer<typeof confirmResponseSchema>;

export const bookingSchema = z.object({
  bookingId: uuid,
  holdId: uuid,
  seat: z.number().int(),
  userId: uuid,
  confirmedAt: iso,
});
export const bookingPageSchema = z.object({
  items: z.array(bookingSchema),
  nextCursor: z.string().nullable(),
});
export const myBookingsSchema = z.object({
  items: z.array(
    z.object({ bookingId: uuid, seat: z.number().int(), confirmedAt: iso }),
  ),
});

export const seatMapSchema = z.object({
  eventId: uuid,
  seatCount: z.number().int(),
  seatsPerRow: z.number().int(),
  seq: z.number().int(),
  bitmap: z.string(),
});
export const seatMapDeltaSchema = z.object({
  seq: z.number().int(),
  change: z.enum(['held', 'booked', 'released']),
  seats: z.array(z.number().int()),
});

/**
 * Topic `launch_events.events` payloads (specs/domains/S22-booking/contracts/events-and-commands.md). The spec names
 * them `launch_events.<name>`, but the S53 type pattern (`EVENT_TYPE_PATTERN`) allows no `_` in the first segment, so the
 * emitted `type` is the alias `launchevents.<name>` (as `developerplatform.*` and `sellerinsights.*` do); S28 resolves
 * the alias to the canonical name. The topic and the aggregate type keep the underscore.
 */
export const LAUNCH_EVENTS_AGGREGATE = 'launch_events';
export const launchEventEventSchemas = {
  'launchevents.event_created': z.object({
    launchEventId: uuid,
    shopId: uuid,
    title: z.string(),
    startsAt: iso,
    salesOpenAt: iso,
    seatCount: z.number().int(),
  }),
  'launchevents.booking_confirmed': z.object({
    holdId: uuid,
    launchEventId: uuid,
    shopId: uuid,
    userId: uuid,
    seats: z.array(z.number().int()),
    bookingIds: z.array(uuid),
    confirmedAt: iso,
  }),
  'launchevents.event_sold_out': z.object({
    launchEventId: uuid,
    shopId: uuid,
  }),
  'launchevents.event_closed': z.object({
    launchEventId: uuid,
    shopId: uuid,
    reason: z.enum(['organizer', 'started']),
  }),
} as const;

/** Single-consumer command to `orders` (S10), dedupe key `booking-voucher:<holdId>`. */
export const bookingVoucherRequestedSchema = z.object({
  holdId: uuid,
  bookingIds: z.array(uuid),
  launchEventId: uuid,
  shopId: uuid,
  userId: uuid,
  seatCount: z.number().int(),
  /** `booking-voucher:<holdId>`: the consumer dedupes on it. */
  dedupeKey: z.string(),
});
export const BOOKING_VOUCHER_COMMAND = 'orders.booking_voucher_requested';
