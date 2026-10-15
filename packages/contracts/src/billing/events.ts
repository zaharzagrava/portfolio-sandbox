import { z } from "zod";
import { isoInstant } from "./catalog.ts";

/**
 * S17 events (specs/domains/S17-subscriptions/contracts/events.md), aggregate `billing`, topic `billing.events`,
 * key `subjectId`. Additive within v1. Money fields end in `Minor`. No payment-method reference ever appears.
 */
const uuid = z.string().uuid();
const subjectType = z.enum(["USER", "SHOP"]);

export const subscriptionStatusChangedSchema = z.object({
  subscriptionId: uuid,
  subjectType,
  subjectId: uuid,
  status: z.string(),
  from: z.string().nullable(),
  planCode: z.string(),
  subscriptionVersion: z.number().int().nonnegative(),
});
export type SubscriptionStatusChangedPayload = z.infer<
  typeof subscriptionStatusChangedSchema
>;

export const subscriptionPlanChangedSchema = z.object({
  shopId: uuid,
  plan: z.enum(["STARTER", "PRO", "ENTERPRISE"]),
  version: z.number().int(),
});
export type SubscriptionPlanChangedPayload = z.infer<
  typeof subscriptionPlanChangedSchema
>;

export const invoicePaymentFailedSchema = z.object({
  invoiceId: uuid,
  subscriptionId: uuid,
  subjectType,
  subjectId: uuid,
  attempt: z.number().int().positive(),
  nextAttemptAt: isoInstant.nullable(),
  reason: z.string(),
  totalMinor: z.number().int(),
  currency: z.string(),
});
export type InvoicePaymentFailedPayload = z.infer<
  typeof invoicePaymentFailedSchema
>;

export const invoicePaidSchema = z.object({
  invoiceId: uuid,
  subscriptionId: uuid,
  subjectType,
  subjectId: uuid,
  kind: z.enum(["RENEWAL", "PRORATION"]),
  totalMinor: z.number().int(),
  currency: z.string(),
  periodStart: isoInstant,
  periodEnd: isoInstant,
  paidAt: isoInstant,
});
export type InvoicePaidPayload = z.infer<typeof invoicePaidSchema>;

export const billingEventSchemas = {
  "billing.subscription_status_changed": subscriptionStatusChangedSchema,
  "billing.subscription_plan_changed": subscriptionPlanChangedSchema,
  "billing.invoice_payment_failed": invoicePaymentFailedSchema,
  "billing.invoice_paid": invoicePaidSchema,
} as const;
