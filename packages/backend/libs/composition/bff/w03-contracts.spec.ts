import {
  cartPageResponseSchema,
  notificationEventSchema,
  orderPageResponseSchema,
  userStreamEventSchema,
} from '@marketplace-sandbox/contracts';
import { cartFixture, orderFixture, paymentFixture } from './testing/fixtures';

const id = '7b0f6c1e-0d52-4d6f-9d0a-2f6b3f1d5a11';

describe('W03 contracts (cart page, order page, user stream)', () => {
  it('cart page: product and shop may be null; quantity is 1..20; unknown members are refused', () => {
    const line = {
      ...cartFixture([id]).lines[0],
      product: null,
      shop: null,
    };
    const body = { lines: [line], droppedLines: 0, errors: [] };
    expect(cartPageResponseSchema.safeParse(body).success).toBe(true);
    expect(
      cartPageResponseSchema.safeParse({
        ...body,
        lines: [{ ...line, quantity: 21 }],
      }).success,
    ).toBe(false);
    expect(
      cartPageResponseSchema.safeParse({ ...body, extra: 1 }).success,
    ).toBe(false);
    expect(
      cartPageResponseSchema.safeParse({
        ...body,
        errors: [{ section: 'shops', code: 'CIRCUIT_OPEN', retryable: true }],
      }).success,
    ).toBe(true);
  });

  it('order page: the payment has no clientSecret and a payment error names the payment section', () => {
    const order = orderFixture();
    const payment = paymentFixture(order.id);
    const view = {
      id: payment.id,
      status: payment.status,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      failureCode: payment.failureCode,
      requiresAction: payment.requiresAction,
      version: payment.version,
      updatedAt: payment.updatedAt,
    };
    expect(
      orderPageResponseSchema.safeParse({ order, payment: view, errors: [] })
        .success,
    ).toBe(true);
    expect(
      orderPageResponseSchema.safeParse({
        order,
        payment: { ...view, clientSecret: 'pi_secret' },
        errors: [],
      }).success,
    ).toBe(false);
    expect(
      orderPageResponseSchema.safeParse({
        order,
        payment: null,
        errors: [
          { section: 'payment', code: 'UPSTREAM_TIMEOUT', retryable: true },
        ],
      }).success,
    ).toBe(true);
  });

  it('user stream: events are discriminated by their SSE event name', () => {
    expect(
      userStreamEventSchema.safeParse({
        type: 'order.status',
        data: { orderId: id, status: 'PAID' },
      }).success,
    ).toBe(true);
    expect(
      userStreamEventSchema.safeParse({
        type: 'payment.status',
        data: { paymentId: id, orderId: id, status: 'COMPLETED', version: 3 },
      }).success,
    ).toBe(true);
    const notification = {
      id,
      type: 'order.confirmed',
      category: 'orders',
      title: 'Confirmed',
      body: 'Thanks',
      link: '/orders/x',
      unread: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(notificationEventSchema.safeParse(notification).success).toBe(true);
    expect(
      userStreamEventSchema.safeParse({
        type: 'notification',
        data: notification,
      }).success,
    ).toBe(true);
    expect(
      userStreamEventSchema.safeParse({ type: 'other', data: {} }).success,
    ).toBe(false);
  });
});
