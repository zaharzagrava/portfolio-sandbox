import { z } from 'zod';
import { CART_LIMITS } from '../orders/cart.ts';
import { sectionCodeSchema } from './product-page.ts';

/** W03 B-3 `GET /bff/cart`: the S10 cart composed with product and shop summaries. Never carries a message or URL (V.3). */
export const CART_PAGE_SECTIONS = ['products', 'shops'] as const;
export const cartPageSectionSchema = z.enum(CART_PAGE_SECTIONS);

export const cartPageErrorSchema = z
  .object({
    section: cartPageSectionSchema,
    code: sectionCodeSchema,
    retryable: z.boolean(),
  })
  .strict();
export type CartPageError = z.infer<typeof cartPageErrorSchema>;

export const cartPageProductSchema = z
  .object({
    title: z.string(),
    priceMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    imageUrl: z.string().nullable(),
    inStock: z.boolean(),
  })
  .strict();

export const cartPageShopSchema = z
  .object({ id: z.string().uuid(), name: z.string() })
  .strict();

export const cartPageLineSchema = z
  .object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(CART_LIMITS.maxQuantity),
    addedAt: z.string(),
    product: cartPageProductSchema.nullable(),
    shop: cartPageShopSchema.nullable(),
  })
  .strict();
export type CartPageLine = z.infer<typeof cartPageLineSchema>;

export const cartPageResponseSchema = z
  .object({
    lines: z.array(cartPageLineSchema).max(CART_LIMITS.maxLines),
    droppedLines: z.number().int().nonnegative(),
    errors: z.array(cartPageErrorSchema),
  })
  .strict();
export type CartPageResponse = z.infer<typeof cartPageResponseSchema>;
