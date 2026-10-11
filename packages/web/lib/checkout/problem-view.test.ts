import { describe, expect, it } from 'vitest';
import { parseCheckoutExtras } from './problem-view';

const A = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const B = '4a3c9d2f-6b5e-4f70-8b8c-2d3e4f5a6b7c';

describe('parseCheckoutExtras (W03 R-12)', () => {
  it('W03 AS-23: price_changed yields the current total and the changed lines', () => {
    expect(
      parseCheckoutExtras('price_changed', { code: 'price_changed', currentTotalMinor: 4200, lines: [{ productId: A, unitPriceMinor: 2100 }], title: 'x' }),
    ).toEqual({ currentTotalMinor: 4200, lines: [{ productId: A, unitPriceMinor: 2100 }] });
  });

  it('W03 AS-23: price_changed with a zero total and no lines is still valid', () => {
    expect(parseCheckoutExtras('price_changed', { currentTotalMinor: 0, lines: [] })).toEqual({ currentTotalMinor: 0, lines: [] });
  });

  it.each([
    ['missing total', { lines: [] }],
    ['float total', { currentTotalMinor: 12.5, lines: [] }],
    ['negative total', { currentTotalMinor: -1, lines: [] }],
    ['string total', { currentTotalMinor: '4200', lines: [] }],
    ['lines not an array', { currentTotalMinor: 1, lines: 'x' }],
    ['line without price', { currentTotalMinor: 1, lines: [{ productId: A }] }],
    ['line with float price', { currentTotalMinor: 1, lines: [{ productId: A, unitPriceMinor: 1.5 }] }],
    ['no body', undefined],
    ['null body', null],
    ['string body', 'price_changed'],
  ])('W03 AS-23: price_changed with %s is unusable (null), so the generic form is shown', (_label, body) => {
    expect(parseCheckoutExtras('price_changed', body)).toBeNull();
  });

  it('W03 AS-24: out_of_stock yields the product ids and the optional flash sale id', () => {
    expect(parseCheckoutExtras('out_of_stock', { productIds: [A, B] })).toEqual({ productIds: [A, B] });
    expect(parseCheckoutExtras('out_of_stock', { productIds: [A], flashSaleId: 'fs-1' })).toEqual({ productIds: [A], flashSaleId: 'fs-1' });
  });

  it('W03 AS-25: product_unavailable yields the product ids', () => {
    expect(parseCheckoutExtras('product_unavailable', { productIds: [B] })).toEqual({ productIds: [B] });
  });

  it.each([
    ['out_of_stock', { productIds: [] }],
    ['out_of_stock', { productIds: [1, 2] }],
    ['out_of_stock', { productIds: 'a' }],
    ['out_of_stock', {}],
    ['out_of_stock', { productIds: [A], flashSaleId: 7 }],
    ['product_unavailable', { productIds: [] }],
    ['product_unavailable', { productIds: [null] }],
    ['product_unavailable', undefined],
  ])('W03 AS-24/AS-25: %s with %j is unusable (null)', (code, body) => {
    expect(parseCheckoutExtras(code, body)).toBeNull();
  });

  it('W03 AS-25: more ids than a cart can hold is unusable', () => {
    expect(parseCheckoutExtras('product_unavailable', { productIds: Array.from({ length: 51 }, (_, i) => `p${i}`) })).toBeNull();
  });

  it.each(['cart_empty', 'mixed_currency', 'idempotency_in_flight', 'checkout_in_progress', 'checkout_unavailable', 'rate_limited', 'teapot', undefined])(
    'W03 FR-081: %s needs no extension fields and gives {} whatever the body holds',
    (code) => {
      expect(parseCheckoutExtras(code, { productIds: [A], currentTotalMinor: 5, whatever: true })).toEqual({});
      expect(parseCheckoutExtras(code, undefined)).toEqual({});
    },
  );
});
