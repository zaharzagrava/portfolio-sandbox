export type BasketSkipReason = 'too_small' | 'too_large';

export type BasketResult =
  | { ok: true; products: string[] }
  | { ok: false; reason: BasketSkipReason };

/**
 * The basket of a paid order (S34 FR-013): distinct products, sorted. A basket needs at least `min` distinct products to
 * form a pair; one above `max` is a bulk order whose O(n²) pairs would only add noise. Repeated lines count once.
 */
export function toBasket(
  productIds: readonly string[],
  bounds: { min: number; max: number },
): BasketResult {
  const products = [...new Set(productIds)].sort();
  if (products.length < bounds.min) return { ok: false, reason: 'too_small' };
  if (products.length > bounds.max) return { ok: false, reason: 'too_large' };
  return { ok: true, products };
}
