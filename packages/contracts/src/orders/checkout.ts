import { z } from 'zod';

export const checkoutRequestSchema = z
  .object({
    expectedTotalMinor: z.number().int().min(0).optional(),
    /** Referral code of a share link (J05). Replaces `refCode`; an unknown, disabled or own code credits no one (never an error). */
    ref: z
      .string()
      .regex(/^[A-Za-z0-9_-]{3,64}$/)
      .optional(),
  })
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
