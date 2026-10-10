import { z } from 'zod';

/** `payments.events` as consumed by orders (S13 may take ownership of these schemas). */
const payload = z.object({
  paymentId: z.string(),
  paymentRef: z.string(),
  orderId: z.string().uuid(),
  userId: z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string(),
  occurredAt: z.string(),
});

export const paymentEventSchemas = {
  'payments.payment_succeeded': payload,
  'payments.payment_failed': payload,
  'payments.payment_refunded': payload,
} as const;
