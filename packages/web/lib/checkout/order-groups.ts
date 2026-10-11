import type { OrderDto } from '@marketplace-sandbox/contracts';
import { unitCount } from '@/lib/cart/totals';

/** What a summary line needs: a display shape, so the pay and success pages hand the client only these fields (VI.8). */
export type OrderSummaryLine = {
  id: string;
  title: string;
  quantity: number;
  lineTotal: { amountMinor: number; currency: string };
};
export type OrderSummaryGroup = { id: string; name: string; lines: OrderSummaryLine[] };

/**
 * An order's items grouped by shop, in order of first appearance (W03 AS-37, AS-48). The order contract carries a shop id
 * but no shop name, so a single shop reads "Your items", several read "Shop 1", "Shop 2", and items with no shop are
 * "Other items" (last). The group id is the shop id: that is its React key.
 */
export function orderSummaryGroups(order: Pick<OrderDto, 'items' | 'currency'>): OrderSummaryGroup[] {
  const byShop = new Map<string, OrderSummaryLine[]>();
  for (const item of order.items) {
    const key = item.shopId ?? 'other';
    const line: OrderSummaryLine = {
      id: item.productId,
      title: item.title,
      quantity: item.quantity,
      lineTotal: { amountMinor: item.lineTotalMinor, currency: order.currency },
    };
    const existing = byShop.get(key);
    if (existing) existing.push(line);
    else byShop.set(key, [line]);
  }
  const shops = [...byShop].filter(([key]) => key !== 'other');
  const groups: OrderSummaryGroup[] = shops.map(([key, lines], position) => ({
    id: key,
    name: shops.length === 1 ? 'Your items' : `Shop ${position + 1}`,
    lines,
  }));
  const other = byShop.get('other');
  if (other) groups.push({ id: 'other', name: 'Other items', lines: other });
  return groups;
}

/** Units in the order: the sum of the quantities. */
export const orderUnitCount = (order: Pick<OrderDto, 'items'>): number => unitCount(order.items);
