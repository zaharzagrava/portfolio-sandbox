import {
  cartPageResponseSchema,
  cartSchema,
  checkoutResponseSchema,
  orderSchema,
  type CartDto,
  type CartPageResponse,
  type CheckoutResponse,
  type OrderDto,
} from '@marketplace-sandbox/contracts';

/**
 * W03 test fixtures for MSW (T002). Success bodies are parsed with the contract schema when built, so a fixture that
 * drifts from the wire shape fails loudly. Problem responses (`application/problem+json`) come from the shared W02 helper.
 * Tests register them with `server.use(http.get('/api/cart', () => HttpResponse.json(cartBody())))` from `@/vitest.setup`.
 */
export { problemResponse, emptyResponse } from '@/lib/test/msw-handlers';

export const PRODUCT_A = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
export const PRODUCT_B = '4a3c9d2f-6b5e-4f70-8b8c-2d3e4f5a6b7c';
export const SHOP_A = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
export const ORDER_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

export function cartBody(overrides: Partial<CartDto> = {}): CartDto {
  return cartSchema.parse({
    lines: [{ productId: PRODUCT_A, quantity: 2, addedAt: '2026-10-10T10:00:00.000Z' }],
    droppedLines: 0,
    ...overrides,
  });
}

export function cartPageBody(overrides: Partial<CartPageResponse> = {}): CartPageResponse {
  return cartPageResponseSchema.parse({
    lines: [
      {
        productId: PRODUCT_A,
        quantity: 2,
        addedAt: '2026-10-10T10:00:00.000Z',
        product: { title: 'Headphones', priceMinor: 1999, currency: 'EUR', imageUrl: null, inStock: true },
        shop: { id: SHOP_A, name: 'Sound Shop' },
      },
    ],
    droppedLines: 0,
    errors: [],
    ...overrides,
  });
}

export function checkoutBody(overrides: Partial<CheckoutResponse> = {}): CheckoutResponse {
  return checkoutResponseSchema.parse({
    orderId: ORDER_ID,
    status: 'RESERVED',
    totalMinor: 3998,
    currency: 'EUR',
    reservedUntil: '2026-10-10T10:15:00.000Z',
    ...overrides,
  });
}

export function orderBody(overrides: Partial<OrderDto> = {}): OrderDto {
  return orderSchema.parse({
    id: ORDER_ID,
    status: 'RESERVED',
    totalMinor: 3998,
    currency: 'EUR',
    reservedUntil: '2026-10-10T10:15:00.000Z',
    createdAt: '2026-10-10T10:00:00.000Z',
    items: [
      { productId: PRODUCT_A, shopId: SHOP_A, title: 'Headphones', quantity: 2, unitPriceMinor: 1999, discountMinor: 0, lineTotalMinor: 3998 },
    ],
    shopOrders: [],
    timeline: [{ status: 'RESERVED', reason: null, at: '2026-10-10T10:00:00.000Z' }],
    ...overrides,
  });
}
