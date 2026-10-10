import { z } from 'zod';

/** S13 HTTP contracts (specs/domains/S13-payment-intents/contracts/http.md). Responses are strict: an extra field fails the e2e parse. */
export const PAYMENT_STATUSES = [
  'PENDING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatusValue = z.infer<typeof paymentStatusSchema>;

export const PAYMENT_CURRENCIES = ['EUR', 'USD', 'GBP'] as const;
export const paymentCurrencySchema = z.enum(PAYMENT_CURRENCIES);
export type PaymentCurrency = z.infer<typeof paymentCurrencySchema>;

/** Closed list: raw provider messages are never exposed. */
export const PAYMENT_FAILURE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'declined_other',
  'provider_rejected',
  'provider_unavailable',
  'provider_canceled',
  'no_provider_record',
  'order_not_payable',
  'order_cancelled',
] as const;
export const paymentFailureCodeSchema = z.enum(PAYMENT_FAILURE_CODES);
export type PaymentFailureCode = z.infer<typeof paymentFailureCodeSchema>;

export const MAX_PAYMENT_AMOUNT_MINOR = 99_999_999;
const amountMinor = z.number().int().min(1).max(MAX_PAYMENT_AMOUNT_MINOR);

export const createPaymentIntentRequestSchema = z
  .object({
    orderId: z.string().uuid(),
    paymentMethodId: z.string().min(1).max(255),
  })
  .strict();
export type CreatePaymentIntentRequest = z.infer<
  typeof createPaymentIntentRequestSchema
>;

export const paymentAcceptedSchema = z
  .object({
    paymentId: z.string().uuid(),
    orderId: z.string().uuid(),
    status: z.literal('PENDING'),
    amountMinor,
    currency: paymentCurrencySchema,
    createdAt: z.string(),
  })
  .strict();
export type PaymentAccepted = z.infer<typeof paymentAcceptedSchema>;

/** No `idempotencyKey`, `providerRef` or `userId`; `clientSecret` is non-null only for the owner while customer action is pending. */
export const paymentSchema = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    status: paymentStatusSchema,
    amountMinor,
    currency: paymentCurrencySchema,
    failureCode: paymentFailureCodeSchema.nullable(),
    requiresAction: z.boolean(),
    clientSecret: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PaymentView = z.infer<typeof paymentSchema>;

export const paymentPageSchema = z
  .object({
    items: z.array(paymentSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type PaymentPage = z.infer<typeof paymentPageSchema>;

export const paymentListQuerySchema = z
  .object({
    orderId: z.string().uuid().optional(),
    status: paymentStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
