import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** `orders.events` (key = orderId → per-order ordering). Consumers: notifications, analytics, leaderboards, seller dashboards. */
export const OrderReserved = defineEvent(
  'order.reserved',
  'orders',
  1,
  z.object({
    userId: z.string(),
    total: z.number().int(),
    currency: z.string(),
    shopIds: z.array(z.string().nullable()),
    reservedUntil: z.string(),
  }),
);

export const OrderPaid = defineEvent(
  'order.paid',
  'orders',
  1,
  z.object({
    userId: z.string(),
    total: z.number().int(),
    /** Added for SD-17 receipts; optional so events recorded before it still parse. */
    currency: z.string().optional(),
    paymentId: z.string(),
    lines: z.array(
      z.object({
        productId: z.string(),
        shopId: z.string().nullable(),
        quantity: z.number().int(),
        price: z.number().int(),
      }),
    ),
  }),
);

export const OrderCancelled = defineEvent(
  'order.cancelled',
  'orders',
  1,
  z.object({
    userId: z.string(),
    reason: z.string(),
  }),
);
