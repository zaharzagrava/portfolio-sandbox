import { z } from 'zod';
import { orderStatusSchema } from './orders/order.ts';
import { paymentStatusSchema } from './payments/payment.ts';
import { notificationRealtimeEventSchema } from './notifications/index.ts';

/**
 * Payloads on the `user:<id>` stream topic. The SSE `event:` name is the discriminator (`type`); the payload is
 * `data.data` of the stream envelope. `orderVersion` is optional: the orders publisher does not send it yet.
 */
export const orderStatusEventSchema = z.object({
  orderId: z.string().uuid(),
  status: orderStatusSchema,
  orderVersion: z.number().int().optional(),
});
export type OrderStatusEvent = z.infer<typeof orderStatusEventSchema>;

export const paymentStatusEventSchema = z.object({
  paymentId: z.string().uuid(),
  orderId: z.string().uuid(),
  status: paymentStatusSchema,
  version: z.number().int(),
});
export type PaymentStatusEvent = z.infer<typeof paymentStatusEventSchema>;

export const userStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('order.status'), data: orderStatusEventSchema }),
  z.object({
    type: z.literal('payment.status'),
    data: paymentStatusEventSchema,
  }),
  z.object({
    type: z.literal('notification'),
    data: notificationRealtimeEventSchema,
  }),
]);
export type UserStreamEvent = z.infer<typeof userStreamEventSchema>;
