import { describe, expect, it } from 'vitest';
import { cartTotals, nextQuantity, type CartItem } from './cart';

const item = (quantity: number, price: number | null): CartItem => ({
  productId: `p-${price}-${quantity}`,
  quantity,
  addedAt: '2026-10-03T00:00:00Z',
  product: price === null ? null : { id: 'p', title: 'P', price, brand: 'B', inStock: true, quantity: 10 },
});

describe('cartTotals', () => {
  it('sums quantity × unit price in cents', () => {
    expect(cartTotals([item(2, 1999), item(1, 500)])).toEqual({ itemCount: 3, subtotal: 4498 });
  });

  it('skips lines whose product no longer exists', () => {
    expect(cartTotals([item(3, null), item(1, 100)])).toEqual({ itemCount: 1, subtotal: 100 });
  });

  it('is zero for an empty cart', () => {
    expect(cartTotals([])).toEqual({ itemCount: 0, subtotal: 0 });
  });
});

describe('nextQuantity', () => {
  it('clamps to 0..20 (the server limit; 0 removes the line)', () => {
    expect(nextQuantity(1, -1)).toBe(0);
    expect(nextQuantity(0, -1)).toBe(0);
    expect(nextQuantity(19, 5)).toBe(20);
    expect(nextQuantity(2, 1)).toBe(3);
  });
});
