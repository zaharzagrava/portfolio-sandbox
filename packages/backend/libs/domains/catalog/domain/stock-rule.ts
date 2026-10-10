import { PRODUCT_LIMITS } from '@marketplace-sandbox/contracts';

export const MAX_QUANTITY = PRODUCT_LIMITS.quantity.max;
export const MAX_DELTA = PRODUCT_LIMITS.stockDelta.max;

export type DeltaResult =
  | { ok: true; quantity: number }
  | {
      ok: false;
      reason: 'invalid_delta' | 'insufficient_stock' | 'quantity_limit';
    };

/**
 * The stock rule (AS-59), the pure twin of the conditional `UPDATE … SET quantity = quantity + :d WHERE quantity + :d
 * BETWEEN 0 AND 1e9`: the new quantity when it stays within `[0, 1e9]`, otherwise a rejection that leaves the quantity
 * alone. A delta is a non-zero integer of at most 1,000,000 in magnitude.
 */
export function applyDelta(quantity: number, delta: number): DeltaResult {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_DELTA)
    return { ok: false, reason: 'invalid_delta' };
  const next = quantity + delta;
  if (next < 0) return { ok: false, reason: 'insufficient_stock' };
  if (next > MAX_QUANTITY) return { ok: false, reason: 'quantity_limit' };
  return { ok: true, quantity: next };
}
