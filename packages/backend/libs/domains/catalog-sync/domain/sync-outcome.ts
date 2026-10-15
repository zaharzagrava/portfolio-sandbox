/**
 * Classification of a stock delta against the quantity on the shelf (FR-013). The catalog's stock command is
 * all-or-nothing and never lets stock go below zero, so an oversold delta is applied as far as it fits and the rest is
 * a conflict; a delta past the maximum quantity applies nothing.
 */
export interface Clamp {
  requested: number;
  applied: number;
  shortfall: number;
}

/** The largest part of `requested` that keeps the quantity at or above zero. */
export function clampDelta(requested: number, quantity: number): Clamp {
  const applied = requested < 0 ? Math.max(requested, -quantity) : requested;
  return {
    requested,
    // `-0` would print as "0" but compare unequal.
    applied: applied === 0 ? 0 : applied,
    shortfall: Math.abs(requested - applied),
  };
}

export type StockClass =
  | { kind: 'full' }
  | {
      kind: 'oversold';
      requested: number;
      applied: number;
      shortfall: number;
    }
  | {
      kind: 'quantity_limit';
      requested: number;
      applied: 0;
      shortfall: number;
    };

export function classifyStock(
  delta: number,
  quantity: number,
  maxQuantity: number,
): StockClass {
  if (quantity + delta > maxQuantity)
    return {
      kind: 'quantity_limit',
      requested: delta,
      applied: 0,
      shortfall: delta,
    };
  if (quantity + delta < 0)
    return { kind: 'oversold', ...clampDelta(delta, quantity) };
  return { kind: 'full' };
}

export type CatalogFailure =
  'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit';

export type FailureOutcome =
  | { result: 'rejected'; code: 'unknown_product' | 'product_unavailable' }
  | { result: 'conflict'; kind: 'quantity_limit' }
  | { result: 'clamp' };

/** `not_found` is the answer for unknown and foreign products alike, so the two cannot be told apart (FR-014). */
export function classifyCatalogFailure(code: CatalogFailure): FailureOutcome {
  switch (code) {
    case 'not_found':
      return { result: 'rejected', code: 'unknown_product' };
    case 'unavailable':
      return { result: 'rejected', code: 'product_unavailable' };
    case 'quantity_limit':
      return { result: 'conflict', kind: 'quantity_limit' };
    case 'insufficient_stock':
      return { result: 'clamp' };
  }
}
