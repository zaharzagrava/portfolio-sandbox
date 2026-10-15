import * as fc from 'fast-check';
import type { WebhookOrderPaidEvent } from '@marketplace-sandbox/contracts';
import {
  affectedOrderShops,
  buildWebhookMessage,
  mapOrderStatusEvent,
  mapPayoutEvent,
  mapProductEvent,
  renderForVersion,
  sliceOrderForShop,
  webhookEventId,
} from './webhook-event-mapper';

const ORDER = '0196a000-0000-7000-8000-00000000000a';
const SHOP_A = '0196a000-0000-7000-8000-0000000000a1';
const SHOP_B = '0196a000-0000-7000-8000-0000000000b1';
const BUYER = 'buyer-user-42';

const paid = (
  over: Partial<WebhookOrderPaidEvent> = {},
): WebhookOrderPaidEvent => ({
  orderId: ORDER,
  userId: BUYER,
  orderVersion: 3,
  totalMinor: 8000,
  currency: 'EUR',
  paymentRef: 'pay_1',
  paidAt: '2026-10-06T12:00:00.000Z',
  lines: [
    {
      productId: 'pa1',
      shopId: SHOP_A,
      title: 'Mug',
      quantity: 2,
      unitPriceMinor: 1500,
      discountMinor: 0,
      lineTotalMinor: 3000,
    },
    {
      productId: 'pa2',
      shopId: SHOP_A,
      title: 'Plate',
      quantity: 1,
      unitPriceMinor: 2000,
      discountMinor: 0,
      lineTotalMinor: 2000,
    },
    {
      productId: 'pb1',
      shopId: SHOP_B,
      title: 'Cup',
      quantity: 1,
      unitPriceMinor: 3000,
      discountMinor: 0,
      lineTotalMinor: 3000,
    },
  ],
  shopOrders: [
    { shopOrderId: 'so-a', shopId: SHOP_A, subtotalMinor: 5000 },
    { shopOrderId: 'so-b', shopId: SHOP_B, subtotalMinor: 3000 },
  ],
  ...over,
});

describe('webhook event mapper (pure)', () => {
  describe('order slice per shop (AS-23)', () => {
    it('S43 AS-23: shop A gets only its own lines and subtotal, in integer minor units', () => {
      const slice = sliceOrderForShop(paid(), SHOP_A)!;
      expect(slice).toEqual({
        type: 'order.paid',
        resource: 'order',
        shopId: SHOP_A,
        resourceVersion: 3,
        object: {
          id: ORDER,
          object: 'order',
          shop_order_id: 'so-a',
          status: 'PAID',
          total: { amount: 5000, currency: 'EUR' },
          lines: [
            {
              product_id: 'pa1',
              title: 'Mug',
              quantity: 2,
              unit_price: { amount: 1500, currency: 'EUR' },
            },
            {
              product_id: 'pa2',
              title: 'Plate',
              quantity: 1,
              unit_price: { amount: 2000, currency: 'EUR' },
            },
          ],
        },
      });
      const text = JSON.stringify(slice);
      expect(text).not.toContain('pb1');
      expect(text).not.toContain('3000');
      expect(text).not.toContain(BUYER);
      expect(text).not.toContain('pay_1');
    });

    it('S43 AS-23: shop B gets the mirror image', () => {
      const slice = sliceOrderForShop(paid(), SHOP_B)!;
      expect(slice.object).toMatchObject({
        shop_order_id: 'so-b',
        total: { amount: 3000, currency: 'EUR' },
        lines: [{ product_id: 'pb1' }],
      });
      const text = JSON.stringify(slice);
      expect(text).not.toContain('pa1');
      expect(text).not.toContain('pa2');
      expect(text).not.toContain('5000');
    });

    it('S43 AS-23: a shop with no line in the order gets nothing', () => {
      expect(sliceOrderForShop(paid(), 'someone-else')).toBeNull();
    });

    it('S43 AS-23: the shops of an order are the distinct shops of its sub-orders and lines, never null', () => {
      expect(affectedOrderShops(paid()).sort()).toEqual(
        [SHOP_A, SHOP_B].sort(),
      );
      expect(
        affectedOrderShops(
          paid({
            lines: [
              {
                productId: 'x',
                shopId: null,
                title: 't',
                quantity: 1,
                unitPriceMinor: 1,
                discountMinor: 0,
                lineTotalMinor: 1,
              },
            ],
            shopOrders: [{ shopOrderId: 's', shopId: null, subtotalMinor: 1 }],
          }),
        ),
      ).toEqual([]);
    });

    it('S43 AS-23 (property): the slices of an order partition its lines, never mention another shop and keep integer amounts', () => {
      const shopIds = [SHOP_A, SHOP_B, 'shop-c', 'shop-d'];
      const lineArb = fc.record({
        shopIndex: fc.integer({ min: 0, max: 3 }),
        quantity: fc.integer({ min: 1, max: 20 }),
        unitPriceMinor: fc.integer({ min: 0, max: 1_000_000 }),
      });
      fc.assert(
        fc.property(
          fc.array(lineArb, { minLength: 1, maxLength: 12 }),
          (raw) => {
            const lines = raw.map((l, i) => ({
              productId: `prod-${i}`,
              shopId: shopIds[l.shopIndex],
              title: `Product ${i}`,
              quantity: l.quantity,
              unitPriceMinor: l.unitPriceMinor,
              discountMinor: 0,
              lineTotalMinor: l.quantity * l.unitPriceMinor,
            }));
            const subtotal = (shop: string) =>
              lines
                .filter((l) => l.shopId === shop)
                .reduce((s, l) => s + l.lineTotalMinor, 0);
            const event = paid({
              lines,
              shopOrders: shopIds
                .filter((s) => lines.some((l) => l.shopId === s))
                .map((s) => ({
                  shopOrderId: `so-${s}`,
                  shopId: s,
                  subtotalMinor: subtotal(s),
                })),
            });
            const seen: string[] = [];
            for (const shop of affectedOrderShops(event)) {
              const slice = sliceOrderForShop(event, shop)!;
              const obj = slice.object as {
                total: { amount: number };
                lines: {
                  product_id: string;
                  quantity: number;
                  unit_price: { amount: number };
                }[];
              };
              expect(Number.isInteger(obj.total.amount)).toBe(true);
              expect(obj.total.amount).toBe(subtotal(shop));
              for (const l of obj.lines) {
                expect(Number.isInteger(l.unit_price.amount)).toBe(true);
                const source = lines.find((x) => x.productId === l.product_id)!;
                expect(source.shopId).toBe(shop); // never another shop's line
                seen.push(l.product_id);
              }
              // nothing of another shop leaks anywhere in the serialised slice
              for (const other of lines.filter((l) => l.shopId !== shop))
                expect(JSON.stringify(slice)).not.toContain(
                  `"${other.productId}"`,
                );
              expect(JSON.stringify(slice)).not.toContain(BUYER);
            }
            expect(seen.sort()).toEqual(lines.map((l) => l.productId).sort()); // partition: all lines, each once
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('cancel and refund (AS-26)', () => {
    const base = {
      orderId: ORDER,
      userId: BUYER,
      orderVersion: 5,
      shopIds: [SHOP_A, SHOP_B],
    };

    it('S43 AS-26: a cancellation carries id, status and reason, no amount and no other shop', () => {
      const mapped = mapOrderStatusEvent(
        'order.cancelled',
        {
          ...base,
          reason: 'payment_failed',
          previousStatus: 'RESERVED',
        } as never,
        SHOP_A,
      );
      expect(mapped).toEqual({
        type: 'order.cancelled',
        resource: 'order',
        shopId: SHOP_A,
        resourceVersion: 5,
        object: {
          id: ORDER,
          object: 'order',
          status: 'CANCELLED',
          reason: 'payment_failed',
        },
      });
      const text = JSON.stringify(mapped);
      expect(text).not.toContain(SHOP_B);
      expect(text).not.toContain(BUYER);
      expect(text).not.toMatch(/amount|total|price/i);
    });

    it('S43 AS-26: a refund carries no amount although the source event does', () => {
      const mapped = mapOrderStatusEvent(
        'order.refunded',
        {
          ...base,
          amountMinor: 8000,
          currency: 'EUR',
          reason: 'requested',
        } as never,
        SHOP_A,
      );
      expect(mapped.object).toEqual({
        id: ORDER,
        object: 'order',
        status: 'REFUNDED',
        reason: 'requested',
      });
      // (a UUID can contain the digits 8000, so the amount is looked for as a value and as a key, not as text)
      expect(Object.values(mapped.object)).not.toContain(8000);
      expect(JSON.stringify(mapped)).not.toMatch(/EUR|amount|total/);
    });
  });

  describe('product events (AS-27)', () => {
    const snapshot = (over: Record<string, unknown> = {}) => ({
      productId: 'p1',
      shopId: SHOP_A,
      title: 'Mug',
      description: 'd',
      brand: 'b',
      category: 'c',
      priceMinor: 1250,
      currency: 'EUR',
      rating: 0,
      tags: [],
      quantity: 7,
      inStock: true,
      status: 'ACTIVE',
      isSandbox: false,
      externalSku: null,
      productVersion: 9,
      createdAt: 'x',
      updatedAt: 'y',
      changedFields: ['title'],
      ...over,
    });

    it.each<[string, string, string, string]>([
      ['catalog.product_created', 'product.created', 'ACTIVE', 'created'],
      ['catalog.product_updated', 'product.updated', 'ACTIVE', 'updated'],
      ['catalog.product_archived', 'product.archived', 'ARCHIVED', 'archived'],
      [
        'catalog.product_restored',
        'product.updated',
        'ACTIVE',
        'restored maps to updated',
      ],
    ])('S43 AS-27: %s -> %s (%s)', (source, type, status, _label) => {
      const mapped = mapProductEvent(source, snapshot({ status }))!;
      expect(mapped).toEqual({
        type,
        resource: 'product',
        shopId: SHOP_A,
        resourceVersion: 9,
        object: {
          id: 'p1',
          object: 'product',
          title: 'Mug',
          price: { amount: 1250, currency: 'EUR' },
          stock: 7,
          status,
          changed_fields: ['title'],
        },
      });
    });

    it('S43 AS-27: a deleted product is {id, object} with the product version', () => {
      expect(
        mapProductEvent('catalog.product_deleted', {
          productId: 'p1',
          shopId: SHOP_A,
          productVersion: 11,
        }),
      ).toEqual({
        type: 'product.deleted',
        resource: 'product',
        shopId: SHOP_A,
        resourceVersion: 11,
        object: { id: 'p1', object: 'product' },
      });
    });

    it('S43 AS-27: catalog.product_changed and unknown types are ignored', () => {
      expect(mapProductEvent('catalog.product_changed', snapshot())).toBeNull();
      expect(mapProductEvent('catalog.something_else', snapshot())).toBeNull();
    });

    it('S43 AS-29: a sandbox product event is dropped, isSandbox never appears in a body', () => {
      expect(
        mapProductEvent(
          'catalog.product_updated',
          snapshot({ isSandbox: true }),
        ),
      ).toBeNull();
      expect(
        JSON.stringify(mapProductEvent('catalog.product_updated', snapshot())),
      ).not.toContain('isSandbox');
    });
  });

  describe('payout events (AS-29)', () => {
    const base = {
      payoutId: 'po1',
      shopId: SHOP_A,
      periodStart: '2026-09-01',
      amountMinor: 123456,
      currency: 'EUR',
      payoutVersion: 4,
    };

    it('S43 AS-29: payout.paid carries amount, period, status and transfer reference', () => {
      expect(
        mapPayoutEvent('payout.paid', {
          ...base,
          transferRef: 'tr_9',
          paidAt: '2026-10-01T00:00:00Z',
        }),
      ).toEqual({
        type: 'payout.paid',
        resource: 'payout',
        shopId: SHOP_A,
        resourceVersion: 4,
        object: {
          id: 'po1',
          object: 'payout',
          amount: { amount: 123456, currency: 'EUR' },
          period_start: '2026-09-01',
          status: 'paid',
          transfer_ref: 'tr_9',
        },
      });
    });

    it('S43 AS-29: payout.failed carries the failure code', () => {
      expect(
        mapPayoutEvent('payout.failed', {
          ...base,
          failureCode: 'account_closed',
        })!.object,
      ).toMatchObject({
        status: 'failed',
        failure_code: 'account_closed',
      });
    });

    it.each([
      'payout.cancelled',
      'payout.in_doubt',
      'payout.discrepancy_detected',
    ])('S43 AS-29: %s is ignored', (type) => {
      expect(mapPayoutEvent(type, base)).toBeNull();
    });

    it('S43 AS-29: isSandbox is dropped from the body and a sandbox payout is not delivered', () => {
      expect(
        JSON.stringify(
          mapPayoutEvent('payout.paid', { ...base, isSandbox: false }),
        ),
      ).not.toContain('isSandbox');
      expect(
        mapPayoutEvent('payout.paid', { ...base, isSandbox: true }),
      ).toBeNull();
    });
  });

  describe('message and ids', () => {
    it('S43 AS-23: the event id is deterministic per source event and shop', () => {
      const a = webhookEventId('0196a000-0000-7000-8000-000000000001', SHOP_A);
      expect(a).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(a).toBe(
        webhookEventId('0196a000-0000-7000-8000-000000000001', SHOP_A),
      );
      expect(a).not.toBe(
        webhookEventId('0196a000-0000-7000-8000-000000000001', SHOP_B),
      );
      expect(a).not.toBe(
        webhookEventId('0196a000-0000-7000-8000-000000000002', SHOP_A),
      );
    });

    it('S43 AS-23: the body is {id, object, type, created, api_version, resource_version, data.object}', () => {
      const body = JSON.parse(
        buildWebhookMessage({
          eventId: 'evt_' + 'a'.repeat(32),
          type: 'order.paid',
          created: '2026-10-06T12:00:00.000Z',
          apiVersion: '2026-10-01',
          resourceVersion: 3,
          object: { id: ORDER, object: 'order' },
        }),
      );
      expect(body).toEqual({
        id: 'evt_' + 'a'.repeat(32),
        object: 'event',
        type: 'order.paid',
        created: '2026-10-06T12:00:00.000Z',
        api_version: '2026-10-01',
        resource_version: 3,
        data: { object: { id: ORDER, object: 'order' } },
      });
    });

    it('S43 AS-24: an older version renders the older shape, a resource without change is rendered as is', () => {
      const slice = sliceOrderForShop(paid(), SHOP_A)!;
      const old = renderForVersion(
        'order',
        slice.object,
        '2026-01-15',
      ) as Record<string, unknown>;
      expect(old.total).toBe(5000);
      expect(old.currency).toBe('EUR');
      const latest = renderForVersion('order', slice.object, '2026-10-01');
      expect(latest).toEqual(slice.object);
      const payout = { id: 'po1', object: 'payout' };
      expect(renderForVersion('payout', payout, '2026-01-15')).toEqual(payout);
    });
  });
});
