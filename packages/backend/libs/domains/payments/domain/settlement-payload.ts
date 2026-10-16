const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettledLine {
  /** Canonical lower-case shop id. */
  shopId: string;
  /** The product's category at purchase; `*` (the default rate) when the event does not carry one. */
  category: string;
  lineTotalMinor: number;
}

/**
 * What settlement needs beyond the `order.paid` contract (research R-6): lines that belong to distinct-shop uuids, whole
 * non-negative totals that add up to the captured amount (which is above zero), and shop subtotals that agree with
 * their lines. Returns the lines with canonical shop ids, or null when the payload cannot be settled and must be
 * dead-lettered as `invalid_payload`.
 */
export function settlementLines(
  lines: readonly {
    shopId: string | null;
    category?: string;
    lineTotalMinor: number;
  }[],
  shopOrders: readonly { shopId: string | null; subtotalMinor: number }[],
  capturedMinor: number,
): SettledLine[] | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (!Array.isArray(shopOrders) || shopOrders.length === 0) return null;

  const perShop = new Map<string, bigint>();
  const settled: SettledLine[] = [];
  let total = 0n;
  for (const line of lines) {
    if (typeof line.shopId !== 'string' || !UUID.test(line.shopId)) return null;
    if (!Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor < 0)
      return null;
    const shopId = line.shopId.toLowerCase();
    settled.push({
      shopId,
      category: line.category?.trim() ? line.category : '*',
      lineTotalMinor: line.lineTotalMinor,
    });
    perShop.set(
      shopId,
      (perShop.get(shopId) ?? 0n) + BigInt(line.lineTotalMinor),
    );
    total += BigInt(line.lineTotalMinor);
  }
  if (total === 0n || total !== BigInt(capturedMinor)) return null;

  const seen = new Set<string>();
  for (const order of shopOrders) {
    if (typeof order.shopId !== 'string' || !UUID.test(order.shopId))
      return null;
    if (!Number.isSafeInteger(order.subtotalMinor) || order.subtotalMinor < 0)
      return null;
    const shopId = order.shopId.toLowerCase();
    if (seen.has(shopId)) return null;
    seen.add(shopId);
    if ((perShop.get(shopId) ?? 0n) !== BigInt(order.subtotalMinor))
      return null;
  }
  if (seen.size !== perShop.size) return null;
  return settled;
}
