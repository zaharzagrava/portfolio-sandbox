import { z } from "zod";

/**
 * S17 catalog contracts (specs/domains/S17-subscriptions/contracts/http.md). Money is integer minor units in fields
 * ending in `Minor`; instants are ISO-8601 UTC. Request bodies are strict: an unknown field is `400 validation_failed`.
 */
export const isoInstant = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const nonNegativeInt = z.number().int().nonnegative();

export const MAX_UNIT_AMOUNT_MINOR = 100_000_000;
export const MAX_TRIAL_DAYS = 90;
export const MAX_QUANTITY = 1000;

export const planCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const shopPlanCodes = ["starter", "pro", "enterprise"] as const;

/** The entitlement keys an operator may set (questions.md LOCAL; S18 may extend the list). */
export const entitlementsSchema = z.strictObject({
  freeShipping: z.boolean().optional(),
  earlyAccessDrops: z.boolean().optional(),
  maxProducts: nonNegativeInt.optional(),
  seats: nonNegativeInt.optional(),
  auctions: z.boolean().optional(),
  apiCallsPerMonth: nonNegativeInt.optional(),
  assistantTokensPerMonth: nonNegativeInt.optional(),
  maxCompetitorWatches: nonNegativeInt.optional(),
});
export type PlanEntitlements = z.infer<typeof entitlementsSchema>;

export const billingIntervalSchema = z.enum(["MONTH", "YEAR"]);
export const billingAudienceSchema = z.enum(["BUYER", "SHOP"]);

const usageMap = z.record(z.string().min(1).max(64), nonNegativeInt);

export const catalogPriceSchema = z.strictObject({
  id: uuid,
  version: z.number().int().min(1),
  interval: billingIntervalSchema,
  unitAmountMinor: nonNegativeInt,
  currency: z.literal("EUR"),
  perSeat: z.boolean(),
  trialDays: nonNegativeInt,
  includedUsage: usageMap,
  overagePer1000Minor: usageMap,
});
export type CatalogPrice = z.infer<typeof catalogPriceSchema>;

export const catalogPlanSchema = z.strictObject({
  code: z.string(),
  name: z.string(),
  audience: billingAudienceSchema,
  entitlements: z.record(z.string(), z.union([z.boolean(), z.number()])),
  prices: z.array(catalogPriceSchema),
});

export const planCatalogSchema = z.strictObject({
  plans: z.array(catalogPlanSchema),
});
export type PlanCatalog = z.infer<typeof planCatalogSchema>;

export const createPlanRequestSchema = z
  .strictObject({
    code: planCodeSchema,
    name: z.string().trim().min(1).max(100),
    audience: billingAudienceSchema,
    entitlements: entitlementsSchema.default({}),
  })
  // A shop plan is one of the tiers the platform understands (seat limits, plan events).
  .refine(
    (plan) =>
      plan.audience === "BUYER" ||
      (shopPlanCodes as readonly string[]).includes(plan.code),
    { path: ["code"], message: "a shop plan code is starter, pro or enterprise" },
  );
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;

export const planSchema = z.strictObject({
  id: uuid,
  code: z.string(),
  name: z.string(),
  audience: billingAudienceSchema,
  entitlements: z.record(z.string(), z.union([z.boolean(), z.number()])),
  createdAt: isoInstant,
});
export type PlanDto = z.infer<typeof planSchema>;

export const createPriceRequestSchema = z.strictObject({
  interval: billingIntervalSchema,
  unitAmountMinor: z.number().int().min(0).max(MAX_UNIT_AMOUNT_MINOR),
  currency: z.literal("EUR").default("EUR"),
  perSeat: z.boolean().default(false),
  trialDays: z.number().int().min(0).max(MAX_TRIAL_DAYS).default(0),
  includedUsage: usageMap.default({}),
  overagePer1000Minor: usageMap.default({}),
});
export type CreatePriceRequest = z.infer<typeof createPriceRequestSchema>;

export const adminPriceSchema = catalogPriceSchema.extend({
  planId: uuid,
  active: z.boolean(),
  createdAt: isoInstant,
});
export type AdminPrice = z.infer<typeof adminPriceSchema>;

export const retirePriceResultSchema = z.strictObject({
  id: uuid,
  active: z.literal(false),
});
