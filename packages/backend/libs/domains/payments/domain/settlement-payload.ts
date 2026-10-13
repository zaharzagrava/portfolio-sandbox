import type { ShopSubtotal } from './settlement-split';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What settlement needs beyond the `order.paid` contract (research R-6): a non-empty list of distinct shops (uuid
 * ids) with whole non-negative subtotals that are not all zero. Returns the shops with canonical lower-case ids, or
 * null when the payload cannot be settled and must be dead-lettered as `invalid_payload`.
 */
export function settlementShops(
  shopOrders: readonly { shopId: string | null; subtotalMinor: number }[],
): ShopSubtotal[] | null {
  if (!Array.isArray(shopOrders) || shopOrders.length === 0) return null;
  const seen = new Set<string>();
  const shops: ShopSubtotal[] = [];
  let total = 0n;
  for (const s of shopOrders) {
    if (typeof s.shopId !== 'string' || !UUID.test(s.shopId)) return null;
    if (!Number.isSafeInteger(s.subtotalMinor) || s.subtotalMinor < 0)
      return null;
    const shopId = s.shopId.toLowerCase();
    if (seen.has(shopId)) return null;
    seen.add(shopId);
    shops.push({ shopId, subtotalMinor: s.subtotalMinor });
    total += BigInt(s.subtotalMinor);
  }
  return total > 0n ? shops : null;
}
