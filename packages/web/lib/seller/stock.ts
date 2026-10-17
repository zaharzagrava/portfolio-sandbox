/** Quantities of this many units or fewer read "Low stock" (the same threshold as the webhook `product.stock_low`, S43). */
export const LOW_STOCK_THRESHOLD = 5;

export type StockStatus = 'archived' | 'out' | 'low' | 'in';

/** "Archived" overrides the quantity; the status is a word in the cell, never a colour alone (W04 AS-39). */
export function stockStatus(quantity: number, status: string): StockStatus {
  if (status === 'ARCHIVED') return 'archived';
  if (quantity <= 0) return 'out';
  return quantity <= LOW_STOCK_THRESHOLD ? 'low' : 'in';
}

export const STOCK_LABEL: Record<StockStatus, string> = {
  archived: 'Archived',
  out: 'Out of stock',
  low: 'Low stock',
  in: 'In stock',
};
