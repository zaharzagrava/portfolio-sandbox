import { z } from 'zod';

export const checkoutRequestSchema = z
  .object({ expectedTotalMinor: z.number().int().min(0).optional() })
  .strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutResponseSchema = z
  .object({
    orderId: z.string().uuid(),
    status: z.literal('RESERVED'),
    totalMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reservedUntil: z.string(),
  })
  .strict();
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
