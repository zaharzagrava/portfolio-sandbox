import { randomUUID } from 'node:crypto';
import { orderSchema } from '@marketplace-sandbox/contracts';
import {
  createOrdersApp,
  orderRow,
  seedPendingOrder,
  seedShopWithProducts,
  type OrdersTestApp,
} from './testing/orders-app';

describe('Orders: GET /orders/:orderId (W03 B-1)', () => {
  let t: OrdersTestApp;

  beforeAll(async () => {
    t = await createOrdersApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const seed = async () => {
    const buyer = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 1_000, quantity: 10 },
      { priceMinor: 250, quantity: 10 },
    ]);
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [
        {
          productId: products[0].id,
          shopId: shop.id,
          quantity: 2,
          unitPriceMinor: 1_000,
        },
        {
          productId: products[1].id,
          shopId: shop.id,
          quantity: 1,
          unitPriceMinor: 250,
        },
      ],
    });
    return { buyer, shop, products, order };
  };

  it('W03 B-1: the owner reads the order with items, shop orders and timeline, parsed by orderSchema', async () => {
    const { buyer, shop, order } = await seed();
    const res = await t.as(buyer).get(`/api/orders/${order.id}`);
    expect(res.status).toBe(200);
    const parsed = orderSchema.parse(res.body);
    expect(parsed.id).toBe(order.id);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.totalMinor).toBe(2_250);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.shopOrders).toHaveLength(1);
    expect(parsed.shopOrders[0].shopId).toBe(shop.id);
    expect(parsed.timeline.length).toBeGreaterThanOrEqual(1);
  });

  it('W03 B-1: another buyer gets 404 order_not_found, identical to an unknown id', async () => {
    const { order } = await seed();
    const other = await t.newUser();
    const foreign = await t.as(other).get(`/api/orders/${order.id}`);
    const unknown = await t.as(other).get(`/api/orders/${randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('order_not_found');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('order_not_found');
    expect(foreign.body.detail).toBe(unknown.body.detail);
  });

  it('W03 B-1: a malformed id is 400', async () => {
    const buyer = await t.newUser();
    const res = await t.as(buyer).get('/api/orders/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('W03 B-1: no token is 401', async () => {
    const { order } = await seed();
    const res = await t.http().get(`/api/orders/${order.id}`);
    expect(res.status).toBe(401);
  });

  it('W03 B-1: the read changes nothing', async () => {
    const { buyer, order } = await seed();
    const before = await orderRow(t.app, order.id);
    await t.as(buyer).get(`/api/orders/${order.id}`);
    await t.as(buyer).get(`/api/orders/${order.id}`);
    expect(await orderRow(t.app, order.id)).toEqual(before);
  });
});
