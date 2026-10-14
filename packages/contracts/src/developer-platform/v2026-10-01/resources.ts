import { z } from 'zod';
import { PRODUCT_LIMITS } from '../../catalog/index.ts';

/** Public API resources at version `2026-10-01` (the latest). Responses are strict: an internal field fails the parse. */
const instant = z.iso.datetime({ offset: true });
export const money = z
  .object({
    amount: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const productSchema = z
  .object({
    id: z.string(),
    object: z.literal('product'),
    livemode: z.boolean(),
    title: z.string(),
    description: z.string(),
    price: money,
    stock: z.number().int(),
    category: z.string(),
    brand: z.string(),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
    created_at: instant,
    updated_at: instant,
  })
  .strict();
export type ProductV20261001 = z.infer<typeof productSchema>;

export const orderSchema = z
  .object({
    id: z.string(),
    object: z.literal('order'),
    livemode: z.boolean(),
    status: z.string(),
    total: money,
    lines: z.array(
      z
        .object({
          product_id: z.string(),
          quantity: z.number().int(),
          unit_price: money,
        })
        .strict(),
    ),
    created_at: instant,
  })
  .strict();
export type OrderV20261001 = z.infer<typeof orderSchema>;

export const listSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
    })
    .strict();

export const stockSchema = z
  .object({
    object: z.literal('stock'),
    product_id: z.string(),
    stock: z.number().int(),
    livemode: z.boolean(),
    updated_at: instant,
  })
  .strict();

/** `POST /v1/products` body at this version. */
export const createProductRequestSchema = z
  .object({
    title: z.string().min(PRODUCT_LIMITS.title.min).max(PRODUCT_LIMITS.title.max),
    description: z
      .string()
      .max(PRODUCT_LIMITS.description.max)
      .optional(),
    price: z
      .object({
        amount: z
          .number()
          .int()
          .min(PRODUCT_LIMITS.priceMinor.min)
          .max(PRODUCT_LIMITS.priceMinor.max),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict(),
    category: z.string().min(PRODUCT_LIMITS.category.min).max(PRODUCT_LIMITS.category.max),
    brand: z.string().min(PRODUCT_LIMITS.brand.min).max(PRODUCT_LIMITS.brand.max),
    stock: z.number().int().min(0).max(PRODUCT_LIMITS.quantity.max).optional(),
  })
  .strict();
export type CreateProductRequestV20261001 = z.infer<
  typeof createProductRequestSchema
>;

export const updateProductRequestSchema = createProductRequestSchema
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field',
  });
