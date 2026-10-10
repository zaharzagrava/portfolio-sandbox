/**
 * Integer money in minor units (S10 FR-017 to FR-019, A10). Every discount that enters here is validated first; a bad
 * one throws `InvalidDiscountError` and the caller falls back to catalogue prices.
 */
export class InvalidDiscountError extends Error {
  constructor(
    readonly reason: 'negative' | 'not_integer' | 'over_gross' | 'unknown_shop',
  ) {
    super(`invalid discount: ${reason}`);
    this.name = 'InvalidDiscountError';
  }
}

const isMinor = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n);

/**
 * Splits `total` over `weights` in proportion, exactly: floors first, the remaining units go to the largest
 * fractional remainders (ties to the earlier line). A line never receives more than its own weight.
 */
export function allocateLargestRemainder(
  total: number,
  weights: number[],
): number[] {
  if (!isMinor(total)) throw new InvalidDiscountError('not_integer');
  if (total < 0) throw new InvalidDiscountError('negative');
  const gross = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (BigInt(total) > gross) throw new InvalidDiscountError('over_gross');
  if (total === 0 || gross === 0n) return weights.map(() => 0);

  const t = BigInt(total);
  const shares = weights.map((w) => (t * BigInt(w)) / gross);
  const remainders = weights.map((w, i) => ({
    i,
    r: (t * BigInt(w)) % gross,
  }));
  let left = Number(t - shares.reduce((s, x) => s + x, 0n));
  remainders
    .filter((x) => x.r > 0n)
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
    .slice(0, left)
    .forEach(({ i }) => {
      shares[i] += 1n;
      left -= 1;
    });
  return shares.map(Number);
}

export interface PricedLineInput {
  productId: string;
  shopId: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface PricedCartInput {
  lines: PricedLineInput[];
  shopDiscounts: Array<{ shopId: string; discountMinor: number }>;
}

export interface PricedLine extends PricedLineInput {
  grossMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
}

export interface PricedCart {
  lines: PricedLine[];
  shops: Array<{ shopId: string; subtotalMinor: number }>;
  grossMinor: number;
  totalMinor: number;
}

/**
 * Prices a cart: per-shop discounts are allocated over that shop's lines by line gross (largest remainder), line
 * totals, shop subtotals (in order of first appearance) and the order total follow. Lines keep their input order.
 */
export function priceCart(input: PricedCartInput): PricedCart {
  const shopIds = [...new Set(input.lines.map((l) => l.shopId))];
  const discountByShop = new Map<string, number>();
  for (const d of input.shopDiscounts) {
    if (!shopIds.includes(d.shopId))
      throw new InvalidDiscountError('unknown_shop');
    if (!isMinor(d.discountMinor))
      throw new InvalidDiscountError('not_integer');
    if (d.discountMinor < 0) throw new InvalidDiscountError('negative');
    discountByShop.set(
      d.shopId,
      (discountByShop.get(d.shopId) ?? 0) + d.discountMinor,
    );
  }

  const priced: PricedLine[] = input.lines.map((l) => ({
    ...l,
    grossMinor: l.unitPriceMinor * l.quantity,
    discountMinor: 0,
    lineTotalMinor: l.unitPriceMinor * l.quantity,
  }));

  for (const shopId of shopIds) {
    const own = priced.filter((l) => l.shopId === shopId);
    const parts = allocateLargestRemainder(
      discountByShop.get(shopId) ?? 0,
      own.map((l) => l.grossMinor),
    );
    own.forEach((l, i) => {
      l.discountMinor = parts[i];
      l.lineTotalMinor = l.grossMinor - parts[i];
    });
  }

  const shops = shopIds.map((shopId) => ({
    shopId,
    subtotalMinor: priced
      .filter((l) => l.shopId === shopId)
      .reduce((s, l) => s + l.lineTotalMinor, 0),
  }));
  return {
    lines: priced,
    shops,
    grossMinor: priced.reduce((s, l) => s + l.grossMinor, 0),
    totalMinor: shops.reduce((s, x) => s + x.subtotalMinor, 0),
  };
}
