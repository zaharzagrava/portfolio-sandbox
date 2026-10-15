import { z } from "zod";
import { isoInstant } from "./catalog.ts";

const uuid = z.string().uuid();
const minor = z.number().int();

export const invoiceKindSchema = z.enum(["RENEWAL", "PRORATION"]);
export const invoiceStatusSchema = z.enum([
  "OPEN",
  "PAID",
  "VOID",
  "UNCOLLECTIBLE",
]);
export const invoiceLineKindSchema = z.enum([
  "PLAN",
  "USAGE",
  "ADJUSTMENT",
  "CREDIT",
  "PRORATION_CREDIT",
  "PRORATION_CHARGE",
  "PRORATION",
]);

export const invoiceLineSchema = z.strictObject({
  kind: invoiceLineKindSchema,
  description: z.string(),
  quantity: z.number().int(),
  amountMinor: minor,
});
export type InvoiceLineDto = z.infer<typeof invoiceLineSchema>;

export const invoiceSummarySchema = z.strictObject({
  id: uuid,
  subscriptionId: uuid,
  kind: invoiceKindSchema,
  status: invoiceStatusSchema,
  totalMinor: minor,
  currency: z.string(),
  periodStart: isoInstant,
  periodEnd: isoInstant,
  createdAt: isoInstant,
  paidAt: isoInstant.nullable(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

export const invoiceSchema = invoiceSummarySchema.extend({
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: isoInstant.nullable(),
  lines: z.array(invoiceLineSchema),
});
export type InvoiceDto = z.infer<typeof invoiceSchema>;

export const invoicePageSchema = z.strictObject({
  items: z.array(invoiceSummarySchema),
  nextCursor: z.string().nullable(),
});
export type InvoicePage = z.infer<typeof invoicePageSchema>;

export const invoiceListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(500).optional(),
});

/** The latest invoice embedded in a subscription (lines included). */
export const latestInvoiceSchema = z.strictObject({
  id: uuid,
  kind: invoiceKindSchema,
  status: invoiceStatusSchema,
  totalMinor: minor,
  lines: z.array(invoiceLineSchema),
});
