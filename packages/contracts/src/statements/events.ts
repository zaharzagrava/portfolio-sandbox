import { z } from 'zod';
import { adjustmentCauseKindSchema } from './statements.ts';

/**
 * S16 events (contracts/events.md). Produced: `statements.period_closed`, `statements.adjustment_booked` on
 * `statements.events`. Consumed: the statements-side `order.paid` fact schema, which picks the fields it keeps
 * (so a buyer identifier is never stored) and is stricter than the producer's contract (S10 adds `lineId`, `category`).
 */
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-\d{2}$/);
const minor = z.number().int();

export const MAX_LINE_TOTAL_MINOR = 1_000_000_000_000;

export const periodClosedSchema = z.strictObject({
  month,
  knowledgeCutoff: isoDateTime,
  shopCount: z.number().int().nonnegative(),
  runId: uuid,
  closedAt: isoDateTime,
});
export type PeriodClosedPayload = z.infer<typeof periodClosedSchema>;

export const adjustmentBookedSchema = z.strictObject({
  adjustmentId: uuid,
  shopId: uuid,
  refersToMonth: month,
  bookedMonth: month,
  causeKind: adjustmentCauseKindSchema,
  causeRef: z.string(),
  grossDeltaMinor: minor,
  commissionDeltaMinor: minor,
  lineCountDelta: z.number().int(),
  payoutsPaidDeltaMinor: minor,
});
export type AdjustmentBookedPayload = z.infer<typeof adjustmentBookedSchema>;

export const statementsEventSchemas = {
  'statements.period_closed': periodClosedSchema,
  'statements.adjustment_booked': adjustmentBookedSchema,
} as const;

const nonNegative = z.number().int().nonnegative();

/**
 * One line of an `order.paid` as statements keeps it. Not strict on purpose: unknown fields are dropped, never
 * stored. The checks that name a dead-letter reason (`missing_line_id`, `missing_shop`, `currency_not_eur`,
 * `line_total_mismatch`, `amount_too_large`) are done by the projector so each failure gets its own reason.
 */
export const orderPaidFactLineSchema = z.object({
  lineId: z.string().min(1),
  productId: z.string().min(1),
  shopId: uuid,
  category: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.string().min(1).max(64)),
  quantity: z.number().int().min(1),
  unitPriceMinor: nonNegative,
  discountMinor: nonNegative,
  lineTotalMinor: nonNegative,
});

export const orderPaidFactSchema = z.object({
  orderId: uuid,
  orderVersion: z.number().int().min(1),
  currency: z.string(),
  paidAt: isoDateTime,
  lines: z.array(orderPaidFactLineSchema),
});
export type OrderPaidFact = z.infer<typeof orderPaidFactSchema>;
