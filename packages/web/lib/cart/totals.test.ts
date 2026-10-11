import type { CartPageLine } from '@marketplace-sandbox/contracts';
import { describe, expect, it } from 'vitest';
import { groupByShop, isAvailable, lineTotalMinor, OTHER_ITEMS, subtotalsByCurrency, unitCount } from './totals';

const SHOP_1 = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
const SHOP_2 = '8d2eab3f-1c40-4d6e-9f70-3b4c5d6e7f80';

let seq = 0;
function line(quantity: number, price: { minor: number; currency?: string; inStock?: boolean } | null, shop: { id: string; name: string } | null = null): CartPageLine {
  seq += 1;
  return {
    productId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    quantity,
    addedAt: '2026-10-10T10:00:00.000Z',
    product: price ? { title: `P${seq}`, priceMinor: price.minor, currency: price.currency ?? 'EUR', imageUrl: null, inStock: price.inStock ?? true } : null,
    shop,
  };
}

describe('cart totals (W03 data-model "Cart view")', () => {
  describe('isAvailable / lineTotalMinor', () => {
    it.each([
      ['priced line', line(3, { minor: 1999 }), true, 5997],
      ['out of stock line still counts', line(2, { minor: 500, inStock: false }), true, 1000],
      ['hidden product', line(2, null), false, null],
    ])('W03 AS-08: %s', (_label, input, available, total) => {
      expect(isAvailable(input)).toBe(available);
      expect(lineTotalMinor(input)).toBe(total);
    });

    it('W03 AS-73: the line total is an exact integer product even for large amounts', () => {
      expect(lineTotalMinor(line(20, { minor: 99_999_999 }))).toBe(1_999_999_980);
    });
  });

  describe('subtotalsByCurrency', () => {
    it.each([
      ['empty cart', [], []],
      ['one currency', [line(2, { minor: 1999 }), line(1, { minor: 500 })], [{ currency: 'EUR', subtotalMinor: 4498 }]],
      ['hidden products are excluded', [line(3, null), line(1, { minor: 100 })], [{ currency: 'EUR', subtotalMinor: 100 }]],
      ['all hidden', [line(1, null)], []],
      [
        'two currencies stay separate, in order of first appearance',
        [line(1, { minor: 1000, currency: 'USD' }), line(2, { minor: 300 }), line(1, { minor: 50, currency: 'USD' })],
        [
          { currency: 'USD', subtotalMinor: 1050 },
          { currency: 'EUR', subtotalMinor: 600 },
        ],
      ],
      ['out of stock lines count', [line(2, { minor: 500, inStock: false })], [{ currency: 'EUR', subtotalMinor: 1000 }]],
    ])('W03 AS-01: %s', (_label, lines, expected) => {
      expect(subtotalsByCurrency(lines)).toEqual(expected);
    });

    it('W03 AS-73: 0.1 + 0.2 style sums stay exact because everything is integer minor units', () => {
      expect(subtotalsByCurrency([line(3, { minor: 10 }), line(3, { minor: 20 })])).toEqual([{ currency: 'EUR', subtotalMinor: 90 }]);
    });
  });

  describe('groupByShop', () => {
    it('W03 AS-03: groups lines by shop in order of first appearance, keeping line order inside a group', () => {
      const a = line(1, { minor: 1 }, { id: SHOP_1, name: 'Sound Shop' });
      const b = line(1, { minor: 1 }, { id: SHOP_2, name: 'Bike Shop' });
      const c = line(1, { minor: 1 }, { id: SHOP_1, name: 'Sound Shop' });
      expect(groupByShop([a, b, c])).toEqual([
        { shopId: SHOP_1, name: 'Sound Shop', lines: [a, c] },
        { shopId: SHOP_2, name: 'Bike Shop', lines: [b] },
      ]);
    });

    it('W03 AS-03: lines without a shop go to "Other items", always last', () => {
      const orphan = line(1, null);
      const shopped = line(1, { minor: 1 }, { id: SHOP_1, name: 'Sound Shop' });
      const orphan2 = line(1, { minor: 1 });
      expect(groupByShop([orphan, shopped, orphan2])).toEqual([
        { shopId: SHOP_1, name: 'Sound Shop', lines: [shopped] },
        { shopId: null, name: OTHER_ITEMS, lines: [orphan, orphan2] },
      ]);
      expect(OTHER_ITEMS).toBe('Other items');
    });

    it('W03 AS-03: an empty cart has no groups', () => {
      expect(groupByShop([])).toEqual([]);
    });

    it('W03 AS-03: groups are keyed by shop id, not by name', () => {
      const a = line(1, { minor: 1 }, { id: SHOP_1, name: 'Same' });
      const b = line(1, { minor: 1 }, { id: SHOP_2, name: 'Same' });
      expect(groupByShop([a, b]).map((group) => group.shopId)).toEqual([SHOP_1, SHOP_2]);
    });
  });

  describe('unitCount', () => {
    it.each([
      [[], 0],
      [[{ quantity: 2 }, { quantity: 20 }, { quantity: 1 }], 23],
    ])('W03 AS-13: %j counts %i units', (lines, expected) => {
      expect(unitCount(lines)).toBe(expected);
    });
  });
});
