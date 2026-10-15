import { z } from "zod";

/** S16 seller statement HTTP contracts (contracts/http.md). Money is an integer in minor units, named `…Minor`. */
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const minor = z.number().int();

export const statementPeriodStatusSchema = z.enum([
  "OPEN",
  "CLOSING",
  "CLOSED",
]);
export type StatementPeriodStatus = z.infer<typeof statementPeriodStatusSchema>;

export const statementTotalsSchema = z.strictObject({
  grossMinor: minor,
  commissionMinor: minor,
  netMinor: minor,
  lineCount: z.number().int(),
  payoutsPaidMinor: minor,
});
export type StatementTotals = z.infer<typeof statementTotalsSchema>;

export const adjustmentCauseKindSchema = z.enum([
  "rate_change",
  "late_sale",
  "late_payout",
]);
export type AdjustmentCauseKind = z.infer<typeof adjustmentCauseKindSchema>;

export const statementAdjustmentSchema = z.strictObject({
  id: uuid,
  shopId: uuid,
  refersToMonth: month,
  bookedMonth: month,
  causeKind: adjustmentCauseKindSchema,
  causeRef: z.string(),
  grossDeltaMinor: minor,
  commissionDeltaMinor: minor,
  lineCountDelta: z.number().int(),
  payoutsPaidDeltaMinor: minor,
  reason: z.string(),
  createdAt: isoDateTime,
});
export type StatementAdjustment = z.infer<typeof statementAdjustmentSchema>;

export const statementSchema = z.strictObject({
  shopId: uuid,
  month,
  currency: z.literal("EUR"),
  status: statementPeriodStatusSchema,
  source: z.enum(["live", "snapshot", "as_known_at"]),
  knownAt: isoDateTime,
  dataAsOf: isoDateTime.nullable(),
  own: statementTotalsSchema,
  adjustmentsBooked: z.array(statementAdjustmentSchema),
  adjustmentsReferencing: z.array(statementAdjustmentSchema),
  total: statementTotalsSchema,
  corrected: statementTotalsSchema,
  unpricedLineCount: z.number().int().nonnegative(),
});
export type Statement = z.infer<typeof statementSchema>;

export const statementPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      month,
      status: statementPeriodStatusSchema,
      total: statementTotalsSchema,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type StatementPage = z.infer<typeof statementPageSchema>;

export const statementMonthParamSchema = month;
export const statementKnownAtSchema = isoDateTime;
