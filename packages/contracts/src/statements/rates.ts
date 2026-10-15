import { z } from "zod";

/**
 * S16 commission-rate HTTP contracts (specs/domains/S16-seller-statements/contracts/http.md). Request bodies are strict
 * (an unknown field is `400 validation_failed`); timestamps are ISO-8601 instants; `rateBps` is an integer 0..10000.
 */
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const commissionRateRuleSchema = z.enum([
  "shop_category",
  "shop_any",
  "default_category",
  "default_any",
]);
export type CommissionRateRule = z.infer<typeof commissionRateRuleSchema>;

export const setCommissionRateRequestSchema = z.strictObject({
  shopId: uuid.optional(),
  category: z.string().trim().min(1).max(64),
  rateBps: z.number().int().min(0).max(10_000),
  validFrom: isoDateTime,
  validTo: isoDateTime.optional(),
  reason: z.string().min(1).max(200),
});
export type SetCommissionRateRequest = z.infer<
  typeof setCommissionRateRequestSchema
>;

export const commissionRateChangeResultSchema = z.strictObject({
  changeId: uuid,
  shopId: uuid.nullable(),
  category: z.string(),
  rateBps: z.number().int(),
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  recordedAt: isoDateTime,
  changed: z.boolean(),
  affectedClosedMonths: z.array(z.string().regex(/^\d{4}-\d{2}$/)),
});
export type CommissionRateChangeResult = z.infer<
  typeof commissionRateChangeResultSchema
>;

export const commissionRateBeliefSchema = z.strictObject({
  id: uuid,
  changeId: uuid,
  shopId: uuid.nullable(),
  category: z.string(),
  rateBps: z.number().int(),
  validFrom: isoDateTime.nullable(),
  validTo: isoDateTime.nullable(),
  recordedFrom: isoDateTime.nullable(),
  recordedTo: isoDateTime.nullable(),
  reason: z.string().nullable(),
  recordedBy: uuid.nullable(),
});

export const commissionRateHistoryPageSchema = z.strictObject({
  items: z.array(commissionRateBeliefSchema),
  nextCursor: z.string().nullable(),
});

export const commissionRateAsOfSchema = z.strictObject({
  rateBps: z.number().int(),
  rule: commissionRateRuleSchema,
  validFrom: isoDateTime.nullable(),
  validTo: isoDateTime.nullable(),
  recordedFrom: isoDateTime.nullable(),
});
export type CommissionRateAsOf = z.infer<typeof commissionRateAsOfSchema>;
