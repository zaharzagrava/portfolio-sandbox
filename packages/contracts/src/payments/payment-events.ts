import { z } from 'zod';
import { paymentFailureCodeSchema } from './payment';

/**
 * `payments.events` v1 (specs/domains/S13-payment-intents/contracts/events.md). Moved from `orders/` (S10 consumes the
 * same schemas). Additive within v1: `payment_failed.paymentRef` may be null (a failure before any provider call has
 * no reference); `reasonCode` on failures; `paymentVersion` on all three. Consumers accept payloads without the two
 * new fields (older producers); `producedPaymentEventSchemas` is what S13 itself publishes: both always present.
 */
const base = {
  paymentId: z.string(),
  orderId: z.string().uuid(),
  userId: z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string(),
  occurredAt: z.string(),
  paymentVersion: z.number().int().positive().optional(),
};

export const paymentEventSchemas = {
  'payments.payment_succeeded': z.object({
    ...base,
    paymentRef: z.string(),
  }),
  'payments.payment_failed': z.object({
    ...base,
    paymentRef: z.string().nullable(),
    reasonCode: paymentFailureCodeSchema.optional(),
  }),
  'payments.payment_refunded': z.object({
    ...base,
    paymentRef: z.string(),
  }),
} as const;

export const producedPaymentEventSchemas = {
  'payments.payment_succeeded':
    paymentEventSchemas['payments.payment_succeeded'].required({
      paymentVersion: true,
    }),
  'payments.payment_failed': paymentEventSchemas[
    'payments.payment_failed'
  ].required({ paymentVersion: true, reasonCode: true }),
  'payments.payment_refunded':
    paymentEventSchemas['payments.payment_refunded'].required({
      paymentVersion: true,
    }),
} as const;
