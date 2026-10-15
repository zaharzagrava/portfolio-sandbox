import { z } from "zod";
import {
  MAX_QUANTITY,
  billingIntervalSchema,
  isoInstant,
} from "./catalog.ts";
import { invoiceLineSchema, latestInvoiceSchema } from "./invoice.ts";

const uuid = z.string().uuid();
const minor = z.number().int();

export const subscriptionStatusSchema = z.enum([
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "UNPAID",
  "CANCELED",
]);
export type SubscriptionStatusDto = z.infer<typeof subscriptionStatusSchema>;

/** A provider payment-method token produced in the customer's browser; stored opaque, never returned. */
export const paymentMethodRefSchema = z
  .string()
  .max(255)
  .regex(/^pm_[A-Za-z0-9_]+$/);

export const subscriptionSchema = z.strictObject({
  id: uuid,
  status: subscriptionStatusSchema,
  plan: z.strictObject({ code: z.string(), name: z.string() }),
  priceId: uuid,
  interval: billingIntervalSchema,
  unitAmountMinor: minor,
  currency: z.string(),
  perSeat: z.boolean(),
  quantity: z.number().int().min(1),
  currentPeriodStart: isoInstant,
  currentPeriodEnd: isoInstant,
  trialEndsAt: isoInstant.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  hasPaymentMethod: z.boolean(),
  creditBalanceMinor: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  latestInvoice: latestInvoiceSchema.nullable(),
});
export type SubscriptionDto = z.infer<typeof subscriptionSchema>;

/** `GET …/subscription`: the subscription (or null) next to S18's entitlements for the subject. */
export const subscriptionReadSchema = z.strictObject({
  subscription: subscriptionSchema.nullable(),
  entitlements: z.record(z.string(), z.union([z.boolean(), z.number()])),
});
export type SubscriptionRead = z.infer<typeof subscriptionReadSchema>;

const quantity = z.number().int().min(1).max(MAX_QUANTITY);

/** There is no `trialDays`: the length of a trial belongs to the price (strict body names the field). */
export const subscribeRequestSchema = z.strictObject({
  priceId: uuid,
  quantity: quantity.optional(),
  paymentMethodRef: paymentMethodRefSchema.optional(),
});
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

export const changeRequestSchema = z.strictObject({
  priceId: uuid.optional(),
  quantity: quantity.optional(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const cancelRequestSchema = z.strictObject({
  immediately: z.boolean().optional(),
});
export type CancelRequest = z.infer<typeof cancelRequestSchema>;

export const paymentMethodRequestSchema = z.strictObject({
  paymentMethodRef: paymentMethodRefSchema,
});
export type PaymentMethodRequest = z.infer<typeof paymentMethodRequestSchema>;

export const previewLineSchema = z.strictObject({
  kind: z.enum(["PRORATION_CREDIT", "PRORATION_CHARGE"]),
  description: z.string(),
  amountMinor: minor,
});

export const changePreviewSchema = z.strictObject({
  lines: z.array(previewLineSchema),
  dueNowMinor: minor,
  creditAppliedMinor: z.number().int().nonnegative(),
  effectiveAt: isoInstant,
});
export type ChangePreview = z.infer<typeof changePreviewSchema>;

export const changeResultSchema = z.strictObject({
  lines: z.array(invoiceLineSchema),
  subscription: subscriptionSchema,
});
export type ChangeResult = z.infer<typeof changeResultSchema>;
