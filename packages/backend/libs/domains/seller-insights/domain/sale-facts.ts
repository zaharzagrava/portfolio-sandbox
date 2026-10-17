import type { SellerInsightsOrderPaid } from '@marketplace-sandbox/contracts';

/** The overall board; a category board is `cat:<normalised category>`. */
export const ALL_BOARD = 'all';
export const categoryBoard = (category: string): string => `cat:${category}`;
export const isCategoryBoard = (board: string): boolean =>
  board.startsWith('cat:');
export const categoryOfBoard = (board: string): string | null =>
  isCategoryBoard(board) ? board.slice(4) : null;

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Lowercase, trimmed, 1 to 64 characters, no control characters; anything else is not a usable category (`null`). */
export function normaliseCategory(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length < 1 || value.length > 64 || CONTROL.test(value)) return null;
  return value;
}

export interface BoardUpdate {
  board: string;
  shopId: string;
  amountMinor: number;
}

export interface BoardPlan {
  updates: BoardUpdate[];
  /** Lines (with revenue) whose product has no known category: they count on the overall board only. */
  categoryUnresolved: number;
  /** Lines whose category is not usable (too long, control characters). */
  categoryInvalid: number;
}

/**
 * What one paid order adds to the boards: per (board, shop) the sum of `lineTotalMinor` (what the buyer paid, never
 * unit price x quantity). A line without revenue adds nothing anywhere; an unknown category counts on the overall
 * board only.
 */
export function boardPlan(
  order: Pick<SellerInsightsOrderPaid, 'lines'>,
  categoryOf: (productId: string) => string | null | undefined,
): BoardPlan {
  const sums = new Map<string, BoardUpdate>();
  let categoryUnresolved = 0;
  let categoryInvalid = 0;
  const add = (board: string, shopId: string, amountMinor: number) => {
    const key = `${board}|${shopId}`;
    const current = sums.get(key);
    if (current) current.amountMinor += amountMinor;
    else sums.set(key, { board, shopId, amountMinor });
  };
  for (const line of order.lines) {
    if (line.lineTotalMinor <= 0) continue;
    add(ALL_BOARD, line.shopId, line.lineTotalMinor);
    const raw = categoryOf(line.productId);
    if (raw === null || raw === undefined) {
      categoryUnresolved++;
      continue;
    }
    const category = normaliseCategory(raw);
    if (category === null) {
      categoryInvalid++;
      continue;
    }
    add(categoryBoard(category), line.shopId, line.lineTotalMinor);
  }
  return { updates: [...sums.values()], categoryUnresolved, categoryInvalid };
}

/** One analytics row per (shop, product) of an order; two lines of the same product are one row. */
export interface SaleRow {
  shopId: string;
  orderId: string;
  productId: string;
  title: string;
  buyerId: string;
  units: number;
  lineTotalMinor: number;
  paidAt: Date;
}

export function saleRows(order: SellerInsightsOrderPaid): SaleRow[] {
  const rows = new Map<string, SaleRow>();
  for (const line of order.lines) {
    const key = `${line.shopId}|${line.productId}`;
    const row = rows.get(key);
    if (row) {
      row.units += line.quantity;
      row.lineTotalMinor += line.lineTotalMinor;
    } else
      rows.set(key, {
        shopId: line.shopId,
        orderId: order.orderId,
        productId: line.productId,
        title: line.title,
        buyerId: order.userId,
        units: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
        paidAt: new Date(order.paidAt),
      });
  }
  return [...rows.values()];
}

export interface ShopSaleTotals {
  shopId: string;
  units: number;
  revenueMinor: number;
}

/** Per shop of a paid order: units and revenue (the order itself counts once per shop). */
export function shopTotals(
  order: Pick<SellerInsightsOrderPaid, 'lines'>,
): ShopSaleTotals[] {
  const totals = new Map<string, ShopSaleTotals>();
  for (const line of order.lines) {
    const current = totals.get(line.shopId) ?? {
      shopId: line.shopId,
      units: 0,
      revenueMinor: 0,
    };
    current.units += line.quantity;
    current.revenueMinor += line.lineTotalMinor;
    totals.set(line.shopId, current);
  }
  return [...totals.values()];
}
