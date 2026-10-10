import { z } from 'zod';

export const ORDER_STATUSES = [
  'PENDING',
  'RESERVED',
  'PAID',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const SHOP_ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'CANCELLED',
  'REFUNDED',
] as const;
export const shopOrderStatusSchema = z.enum(SHOP_ORDER_STATUSES);

export const ORDER_PAGE_LIMITS = { min: 1, max: 100, default: 20 } as const;

const minor = z.number().int().nonnegative();

export const orderItemSchema = z
  .object({
    productId: z.string().uuid(),
    shopId: z.string().uuid().nullable(),
    title: z.string(),
    quantity: z.number().int().positive(),
    unitPriceMinor: minor,
    discountMinor: minor,
    lineTotalMinor: minor,
  })
  .strict();

export const orderSchema = z
  .object({
    id: z.string().uuid(),
    status: orderStatusSchema,
    totalMinor: minor,
    currency: z.string(),
    reservedUntil: z.string().nullable(),
    createdAt: z.string(),
    items: z.array(orderItemSchema),
    shopOrders: z.array(
      z
        .object({
          id: z.string().uuid(),
          shopId: z.string().uuid().nullable(),
          subtotalMinor: minor,
          status: shopOrderStatusSchema,
        })
        .strict(),
    ),
    timeline: z.array(
      z
        .object({
          status: orderStatusSchema,
          reason: z.string().nullable(),
          at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type OrderDto = z.infer<typeof orderSchema>;

export const orderListItemSchema = z
  .object({
    id: z.string().uuid(),
    status: orderStatusSchema,
    totalMinor: minor,
    currency: z.string(),
    createdAt: z.string(),
  })
  .strict();

export const orderPageSchema = z
  .object({
    items: z.array(orderListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const shopOrderPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          shopOrderId: z.string().uuid(),
          orderId: z.string().uuid(),
          status: shopOrderStatusSchema,
          subtotalMinor: minor,
          currency: z.string(),
          buyerId: z.string(),
          createdAt: z.string(),
          items: z.array(orderItemSchema),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();
