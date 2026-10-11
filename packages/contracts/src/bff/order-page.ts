import { z } from 'zod';
import { orderSchema } from '../orders/order.ts';
import {
  paymentCurrencySchema,
  paymentFailureCodeSchema,
  paymentStatusSchema,
} from '../payments/payment.ts';
import { sectionCodeSchema } from './product-page.ts';

/** W03 B-4 `GET /bff/orders/:orderId`: the order plus its latest payment. `clientSecret` is never copied. */
export const orderPagePaymentSchema = z
  .object({
    id: z.string().uuid(),
    status: paymentStatusSchema,
    amountMinor: z.number().int().positive(),
    currency: paymentCurrencySchema,
    failureCode: paymentFailureCodeSchema.nullable(),
    requiresAction: z.boolean(),
    version: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();
export type OrderPagePayment = z.infer<typeof orderPagePaymentSchema>;

export const orderPageErrorSchema = z
  .object({
    section: z.literal('payment'),
    code: sectionCodeSchema,
    retryable: z.boolean(),
  })
  .strict();
export type OrderPageError = z.infer<typeof orderPageErrorSchema>;

export const orderPageResponseSchema = z
  .object({
    order: orderSchema,
    payment: orderPagePaymentSchema.nullable(),
    errors: z.array(orderPageErrorSchema),
  })
  .strict();
export type OrderPageResponse = z.infer<typeof orderPageResponseSchema>;
