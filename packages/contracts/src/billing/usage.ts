import { z } from "zod";
import { isoInstant } from "./catalog.ts";

/**
 * S18 usage summary (specs/domains/S18-usage-entitlements/contracts/http.md): one UTC calendar month of a subject's
 * usage against its plan limits. `limit` and `remaining` are `null` for a metric no plan limit covers.
 */
export const usageMetricSchema = z.object({
  metric: z.string(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
});
export type UsageMetricDto = z.infer<typeof usageMetricSchema>;

export const usageSummarySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  periodStart: isoInstant,
  periodEnd: isoInstant,
  asOf: isoInstant,
  metrics: z.array(usageMetricSchema),
});
export type UsageSummaryDto = z.infer<typeof usageSummarySchema>;
