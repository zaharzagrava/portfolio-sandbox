import { describe, expect, it } from 'vitest';
import { LOW_STOCK_THRESHOLD, STOCK_LABEL, stockStatus } from './stock';

describe('W04 AS-39 stockStatus', () => {
  it('uses the same threshold as the webhook product.stock_low event', () => {
    expect(LOW_STOCK_THRESHOLD).toBe(5);
  });

  it.each([
    [0, 'ACTIVE', 'out', 'Out of stock'],
    [3, 'ACTIVE', 'low', 'Low stock'],
    [5, 'ACTIVE', 'low', 'Low stock'],
    [6, 'ACTIVE', 'in', 'In stock'],
    [0, 'ARCHIVED', 'archived', 'Archived'],
    [3, 'ARCHIVED', 'archived', 'Archived'],
    [600, 'ARCHIVED', 'archived', 'Archived'],
    [-1, 'ACTIVE', 'out', 'Out of stock'],
  ] as const)('quantity %i, %s is %s with the word "%s"', (quantity, status, expected, label) => {
    expect(stockStatus(quantity, status)).toBe(expected);
    expect(STOCK_LABEL[expected]).toBe(label);
  });
});
