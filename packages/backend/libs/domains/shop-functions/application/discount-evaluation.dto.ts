import { z } from 'zod';

/** What orders hands over at checkout (contracts/internal.md): lines of every shop in the cart. */
export type DiscountCartDto = {
  /** Three uppercase letters. */
  currency: string;
  lines: {
    productId: string;
    shopId: string;
    category: string;
    quantity: number;
    unitPriceMinor: number;
  }[];
};

/** One integer amount per shop that has a discount greater than 0. */
export type DiscountEvaluationDto = {
  shopDiscounts: { shopId: string; discountMinor: number }[];
};

export const MAX_CART_LINES = 50;
export const MAX_CART_SHOPS = 10;

/** Validated before anything else; a failure means "invalid cart", never an exception to the caller. */
export const discountCartSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        shopId: z.string().min(1),
        category: z.string(),
        quantity: z.number().int().min(1).max(1_000_000),
        unitPriceMinor: z.number().int().min(0).max(1_000_000_000_000),
      }),
    )
    .min(1)
    .max(MAX_CART_LINES),
});
