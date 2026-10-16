export interface SettlementLine {
  shopId: string;
  lineTotalMinor: number;
  /** Commission of this line (S16.R-04, priced by `CommissionRateQueryService.priceLines`). */
  commissionMinor: number;
}

export interface ShopShare {
  shopId: string;
  shareMinor: number;
}

export interface SettlementSplit {
  /** One entry per shop, ascending shop id; may be zero. */
  shares: ShopShare[];
  /** What the platform keeps: the sum of the lines' commissions. */
  commissionMinor: number;
}

/**
 * What an order's settlement books (S14.R-11, R-15): each shop is owed the totals of its lines less their commission,
 * the platform keeps the commission, so shares plus commission equal the lines exactly and no rounding is left over.
 * Throws `RangeError` for a malformed line (negative or fractional money, a commission above its line, no lines).
 */
export function splitSettlement(
  lines: readonly SettlementLine[],
): SettlementSplit {
  if (lines.length === 0) throw new RangeError('no lines');
  const byShop = new Map<string, number>();
  let commissionMinor = 0;
  for (const line of lines) {
    if (
      !Number.isSafeInteger(line.lineTotalMinor) ||
      !Number.isSafeInteger(line.commissionMinor) ||
      line.lineTotalMinor < 0 ||
      line.commissionMinor < 0 ||
      line.commissionMinor > line.lineTotalMinor
    )
      throw new RangeError(
        'line amounts must be whole, non-negative, commission within the line',
      );
    byShop.set(
      line.shopId,
      (byShop.get(line.shopId) ?? 0) +
        line.lineTotalMinor -
        line.commissionMinor,
    );
    commissionMinor += line.commissionMinor;
  }
  const shares = [...byShop.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([shopId, shareMinor]) => ({ shopId, shareMinor }));
  return { shares, commissionMinor };
}
