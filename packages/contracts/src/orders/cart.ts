import { z } from 'zod';

/** S10 cart contracts (specs/domains/S10-cart-checkout/contracts/http.md). Response schemas are strict. */
export const CART_LIMITS = {
  maxLines: 50,
  maxQuantity: 20,
  lineTtlDays: 30,
} as const;

export const cartLineSchema = z
  .object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(CART_LIMITS.maxQuantity),
    addedAt: z.string(),
  })
  .strict();

export const cartSchema = z
  .object({
    lines: z.array(cartLineSchema).max(CART_LIMITS.maxLines),
    droppedLines: z.number().int().nonnegative(),
  })
  .strict();
export type CartDto = z.infer<typeof cartSchema>;

/** `0` removes the line. */
export const setCartLineRequestSchema = z
  .object({
    quantity: z.number().int().min(0).max(CART_LIMITS.maxQuantity),
  })
  .strict();
export type SetCartLineRequest = z.infer<typeof setCartLineRequestSchema>;
