import { z } from 'zod';

/**
 * S15 payout HTTP contracts (specs/domains/S15-payouts/contracts/http.md). Money fields end in `Minor` and are
 * integers; timestamps are ISO-8601 UTC strings; `periodStart` is `YYYY-MM-DD`. The seller bodies carry the public
 * status set only and never a destination, an attempt count or a raw failure text.
 */
const isoDateTime = z.string().datetime({ offset: true });
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

export const payoutStatusesInternal = [
  'PENDING',
  'SENDING',
  'UNKNOWN',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const;
export const payoutStatusInternalSchema = z.enum(payoutStatusesInternal);
export type PayoutStatusInternal = z.infer<typeof payoutStatusInternalSchema>;

export const payoutStatusesPublic = [
  'PENDING',
  'IN_TRANSIT',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const;
export const payoutStatusPublicSchema = z.enum(payoutStatusesPublic);
export type PayoutStatusPublic = z.infer<typeof payoutStatusPublicSchema>;

export const payoutCurrencySchema = z.literal('EUR');

/** Seller view (`GET /shops/:shopId/payouts`). */
export const payoutSchema = z.object({
  id: uuid,
  shopId: uuid,
  periodStart: calendarDay,
  amountMinor: z.number().int().positive(),
  reserveHeldMinor: z.number().int().nonnegative(),
  currency: payoutCurrencySchema,
  status: payoutStatusPublicSchema,
  transferRef: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: isoDateTime,
  paidAt: isoDateTime.nullable(),
});
export type PayoutView = z.infer<typeof payoutSchema>;

export const payoutPageSchema = z.object({
  items: z.array(payoutSchema),
  nextCursor: z.string().nullable(),
});

export const payoutDetailSchema = payoutSchema.extend({
  timeline: z.array(
    z.object({ status: payoutStatusPublicSchema, at: isoDateTime }),
  ),
});
export type PayoutDetailView = z.infer<typeof payoutDetailSchema>;

export const upcomingBlockedReasons = [
  'payouts_disabled',
  'destination_missing',
  'destination_cooling',
  'below_minimum',
] as const;

/** `GET /shops/:shopId/payouts/upcoming`. */
export const upcomingPayoutSchema = z.object({
  shopId: uuid,
  currency: payoutCurrencySchema,
  availableMinor: z.number().int(),
  reserveMinor: z.number().int().nonnegative(),
  estimatedPayoutMinor: z.number().int().nonnegative(),
  nextRunAt: isoDateTime,
  blockedReason: z.enum(upcomingBlockedReasons).nullable(),
});
export type UpcomingPayoutView = z.infer<typeof upcomingPayoutSchema>;

/** Operator view: internal statuses, attempts, sanitized reason and the masked destination. */
export const adminPayoutSchema = payoutSchema.extend({
  status: payoutStatusInternalSchema,
  attempts: z.number().int().nonnegative(),
  failureReason: z.string().max(200).nullable(),
  destination: z.string().nullable(),
});
export type AdminPayoutView = z.infer<typeof adminPayoutSchema>;

export const adminPayoutPageSchema = z.object({
  items: z.array(adminPayoutSchema),
  nextCursor: z.string().nullable(),
});

export const payoutRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);

export const payoutRunSchema = z.object({
  periodStart: calendarDay,
  status: payoutRunStatusSchema,
  created: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  skipped: z.record(z.string(), z.number().int().nonnegative()),
  failureCode: z.string().nullable(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});
export type PayoutRunView = z.infer<typeof payoutRunSchema>;

export const payoutRunPageSchema = z.object({
  items: z.array(payoutRunSchema),
  nextCursor: z.string().nullable(),
});

/** `PUT /finance/shops/:shopId/payout-destination` (strict). The format is checked by the service: `422 destination_invalid`. */
export const setPayoutDestinationRequestSchema = z
  .object({ providerAccountId: z.string() })
  .strict();
export const payoutDestinationResponseSchema = z.object({
  shopId: uuid,
  providerAccountId: z.string(),
  status: z.literal('ACTIVE'),
  effectiveFrom: isoDateTime,
  changedAt: isoDateTime,
});
export type PayoutDestinationView = z.infer<
  typeof payoutDestinationResponseSchema
>;

/** `PUT /finance/shops/:shopId/payout-reserve` (strict). */
export const setPayoutReserveRequestSchema = z
  .object({
    reserveBps: z.number().int().min(0).max(5000),
    reason: z.string().min(1).max(200),
  })
  .strict();
export const payoutReserveResponseSchema = z.object({
  shopId: uuid,
  reserveBps: z.number().int().min(0).max(5000),
  reason: z.string(),
  updatedBy: z.string(),
  updatedAt: isoDateTime,
});
export type PayoutReserveView = z.infer<typeof payoutReserveResponseSchema>;

/** `POST /finance/payouts/:payoutId/cancel` (strict). */
export const cancelPayoutRequestSchema = z
  .object({ reason: z.string().min(1).max(200) })
  .strict();
