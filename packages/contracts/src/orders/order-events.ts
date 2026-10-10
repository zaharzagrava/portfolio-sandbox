import { z } from 'zod';
import { orderStatusSchema } from './order';

/** `orders.events` payloads (specs/domains/S10-cart-checkout/contracts/events.md). Every payload carries `orderVersion`. */
const minor = z.number().int().nonnegative();
const base = {
  orderId: z.string().uuid(),
  userId: z.string(),
  orderVersion: z.number().int().positive(),
};

export const CANCEL_REASONS = [
  'out_of_stock',
  'payment_failed',
  'hold_expired',
  'user_cancelled',
] as const;
export const cancelReasonSchema = z.enum(CANCEL_REASONS);
export type CancelReason = z.infer<typeof cancelReasonSchema>;

export const orderEventSchemas = {
  'order.reserved': z.object({
    ...base,
    totalMinor: minor,
    currency: z.string(),
    shopIds: z.array(z.string().nullable()),
    reservedUntil: z.string(),
  }),
  'order.paid': z.object({
    ...base,
    totalMinor: minor,
    currency: z.string(),
    paymentRef: z.string(),
    paidAt: z.string(),
    lines: z.array(
      z.object({
        productId: z.string(),
        shopId: z.string().nullable(),
        title: z.string(),
        quantity: z.number().int().positive(),
        unitPriceMinor: minor,
        discountMinor: minor,
        lineTotalMinor: minor,
      }),
    ),
    shopOrders: z.array(
      z.object({
        shopOrderId: z.string(),
        shopId: z.string().nullable(),
        subtotalMinor: minor,
      }),
    ),
  }),
  'order.cancelled': z.object({
    ...base,
    reason: cancelReasonSchema,
    previousStatus: orderStatusSchema,
  }),
  'order.refunded': z.object({
    ...base,
    amountMinor: minor,
    currency: z.string(),
    reason: z.string(),
  }),
  'order.fulfilment_changed': z.object({
    ...base,
    status: z.enum(['FULFILLING', 'SHIPPED', 'DELIVERED']),
    trackingCode: z.string().optional(),
  }),
} as const;

/** Single-consumer message produced when a genuine payment meets a cancelled order (consumer: S13). */
export const refundRequestedSchema = z.object({
  orderId: z.string().uuid(),
  paymentRef: z.string(),
  amountMinor: minor,
  currency: z.string(),
  reason: z.literal('order_cancelled'),
});
export type RefundRequested = z.infer<typeof refundRequestedSchema>;
