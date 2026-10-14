import { z } from 'zod';

/** Public API resources at version `2026-01-15`: integer money, `quantity` instead of `stock`. */
const instant = z.iso.datetime({ offset: true });

export const productSchema = z
  .object({
    id: z.string(),
    object: z.literal('product'),
    livemode: z.boolean(),
    title: z.string(),
    description: z.string(),
    price: z.number().int(),
    quantity: z.number().int(),
    category: z.string(),
    brand: z.string(),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
    created_at: instant,
    updated_at: instant,
  })
  .strict();

export const orderSchema = z
  .object({
    id: z.string(),
    object: z.literal('order'),
    livemode: z.boolean(),
    status: z.string(),
    total: z.number().int(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    lines: z.array(
      z
        .object({
          product_id: z.string(),
          quantity: z.number().int(),
          unit_price: z.number().int(),
        })
        .strict(),
    ),
    created_at: instant,
  })
  .strict();

export const createProductRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    price: z.number().int().min(1),
    category: z.string().min(1).max(100),
    brand: z.string().max(100).optional(),
    quantity: z.number().int().min(0).optional(),
  })
  .strict();
