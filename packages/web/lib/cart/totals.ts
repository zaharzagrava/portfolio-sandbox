import type { CartPageLine } from '@marketplace-sandbox/contracts';

/**
 * Pure cart arithmetic for display (W03 data-model "Cart view", AS-73). Everything is integer minor units: a line total is
 * `priceMinor x quantity`, subtotals are integer sums per currency. The server decides the real total at checkout; these
 * numbers are the "estimated" ones the page shows.
 */

export const OTHER_ITEMS = 'Other items';

/** A line with a known product can be priced; a hidden or deleted product (`product: null`) cannot. */
export const isAvailable = (line: CartPageLine): boolean => line.product !== null;

export function lineTotalMinor(line: CartPageLine): number | null {
  return line.product ? line.product.priceMinor * line.quantity : null;
}

export type CurrencySubtotal = { currency: string; subtotalMinor: number };

/** Subtotal per currency over the available lines, currencies in order of first appearance; none when nothing is priced. */
export function subtotalsByCurrency(lines: readonly CartPageLine[]): CurrencySubtotal[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (!line.product) continue;
    totals.set(line.product.currency, (totals.get(line.product.currency) ?? 0) + line.product.priceMinor * line.quantity);
  }
  return [...totals].map(([currency, subtotalMinor]) => ({ currency, subtotalMinor }));
}

export type ShopGroup = { shopId: string | null; name: string; lines: CartPageLine[] };

/** Lines grouped by `shop.id` in order of first appearance; lines without a shop form "Other items", always last. */
export function groupByShop(lines: readonly CartPageLine[]): ShopGroup[] {
  const groups = new Map<string, ShopGroup>();
  const other: CartPageLine[] = [];
  for (const line of lines) {
    if (!line.shop) {
      other.push(line);
      continue;
    }
    const group = groups.get(line.shop.id);
    if (group) group.lines.push(line);
    else groups.set(line.shop.id, { shopId: line.shop.id, name: line.shop.name, lines: [line] });
  }
  const result = [...groups.values()];
  if (other.length > 0) result.push({ shopId: null, name: OTHER_ITEMS, lines: other });
  return result;
}

/** Units in the cart (the badge): the sum of every line's quantity, available or not. */
export function unitCount(lines: readonly { quantity: number }[]): number {
  let count = 0;
  for (const line of lines) count += line.quantity;
  return count;
}
