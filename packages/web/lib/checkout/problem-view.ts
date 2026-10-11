import { z } from 'zod';

/**
 * The extension fields of the checkout problems the UI acts on (W03 R-12, FR-081). The stable `code` is read by the
 * caller; this parses the rest of the problem body with zod. A body that does not carry what its code promises gives
 * `null`, and the caller shows the generic form (FR-082) instead of guessing. Unknown fields are dropped.
 */

const MAX_IDS = 50;
const productIds = z.array(z.string().min(1).max(64)).min(1).max(MAX_IDS);

const priceChangedSchema = z.object({
  currentTotalMinor: z.number().int().nonnegative(),
  lines: z.array(z.object({ productId: z.string().min(1).max(64), unitPriceMinor: z.number().int().nonnegative() })).max(MAX_IDS),
});
const outOfStockSchema = z.object({ productIds, flashSaleId: z.string().min(1).max(100).optional() });
const unavailableSchema = z.object({ productIds });

export type CheckoutExtras = {
  /** `price_changed`: the total the server computes now, in the order's currency. */
  currentTotalMinor?: number;
  /** `price_changed`: the new unit price of each changed line. */
  lines?: { productId: string; unitPriceMinor: number }[];
  /** `out_of_stock`, `product_unavailable`. */
  productIds?: string[];
  /** `out_of_stock` on a flash sale item (S11). */
  flashSaleId?: string;
};

export function parseCheckoutExtras(code: string | undefined, body: unknown): CheckoutExtras | null {
  switch (code) {
    case 'price_changed': {
      const parsed = priceChangedSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    }
    case 'out_of_stock': {
      const parsed = outOfStockSchema.safeParse(body);
      if (!parsed.success) return null;
      return { productIds: parsed.data.productIds, ...(parsed.data.flashSaleId ? { flashSaleId: parsed.data.flashSaleId } : {}) };
    }
    case 'product_unavailable': {
      const parsed = unavailableSchema.safeParse(body);
      return parsed.success ? { productIds: parsed.data.productIds } : null;
    }
    default:
      return {};
  }
}
