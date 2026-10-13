export interface ShopSubtotal {
  shopId: string;
  subtotalMinor: number;
}

export interface ShopShare {
  shopId: string;
  shareMinor: number;
}

/**
 * Largest-remainder split of the net over the shops' subtotals (FR-015). Shops are taken in ascending id order, so
 * ties in the remainders go to the lowest shop id whatever the input order. Exact for any safe-integer inputs
 * (BigInt arithmetic: `net x subtotal` can pass 2^53). The shares sum to `netMinor`.
 */
export function splitSettlement(
  netMinor: number,
  shops: readonly ShopSubtotal[],
): ShopShare[] {
  if (!Number.isSafeInteger(netMinor) || netMinor < 0)
    throw new RangeError('net must be a non-negative safe integer');
  if (shops.length === 0) throw new RangeError('no shops');
  const ordered = [...shops].sort((a, b) =>
    a.shopId < b.shopId ? -1 : a.shopId > b.shopId ? 1 : 0,
  );
  let total = 0n;
  for (const s of ordered) {
    if (!Number.isSafeInteger(s.subtotalMinor) || s.subtotalMinor < 0)
      throw new RangeError('subtotals must be non-negative safe integers');
    total += BigInt(s.subtotalMinor);
  }
  if (total === 0n) throw new RangeError('subtotals sum to zero');

  const net = BigInt(netMinor);
  const rows = ordered.map((s, index) => {
    const product = net * BigInt(s.subtotalMinor);
    return { index, floor: product / total, remainder: product % total };
  });
  let left = net - rows.reduce((a, r) => a + r.floor, 0n);
  const byRemainder = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  const shares = rows.map((r) => r.floor);
  for (const r of byRemainder) {
    if (left === 0n) break;
    // a shop with a zero subtotal has a zero remainder and is never ahead of one with a positive remainder
    shares[r.index] += 1n;
    left -= 1n;
  }
  return ordered.map((s, i) => ({
    shopId: s.shopId,
    shareMinor: Number(shares[i]),
  }));
}
