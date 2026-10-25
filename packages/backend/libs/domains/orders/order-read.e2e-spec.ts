import { randomUUID } from 'node:crypto';
import { orderSchema } from '@marketplace-sandbox/contracts';
import { Role } from '@app/domains/identity';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  orderPageSchema,
  shopOrderPageSchema,
} from '@marketplace-sandbox/contracts';
import { OrderQueryService } from './application/order-query.service';
import {
  OrderNotFoundError,
  OrderNotPayableError,
  TooManyIdsError,
} from './domain/order-errors';
import { USER_HISTORY_PAGE_SQL } from './infra/order.repository';
import {
  createOrdersApp,
  exec,
  rows,
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

describe('Orders: reads, history and tenant isolation', () => {
  let t: OrdersTestApp;
  let queries: OrderQueryService;

  beforeAll(async () => {
    t = await createOrdersApp();
    queries = t.app.get(OrderQueryService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const line = (productId: string, shopId: string, quantity = 1) => ({
    productId,
    shopId,
    quantity,
    unitPriceMinor: 500,
  });
  const idsOf = (page: { items: Array<{ id: string }> }) =>
    page.items.map((i) => i.id);

  it('S10 AS-58: a shop member and an admin who are not the buyer get the same 404 as for a missing order', async () => {
    const buyer = await t.newUser();
    const member = await t.newUser();
    const admin = await t.newUser({ role: Role.ADMIN });
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 10 },
    ]);
    await addMember(t.app, shop.id, member.id, 'OWNER');
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(products[0].id, shop.id)],
    });
    const missing = await t.as(member).get(`/api/orders/${randomUUID()}`);
    for (const who of [member, admin]) {
      const res = await t.as(who).get(`/api/orders/${order.id}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(missing.body.code);
      expect(res.body.detail).toBe(missing.body.detail);
      expect(res.body.title).toBe(missing.body.title);
    }
  });

  it('S10 AS-58: the body carries no persistence field', async () => {
    const buyer = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 10 },
    ]);
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(products[0].id, shop.id)],
    });
    const res = await t.as(buyer).get(`/api/orders/${order.id}`);
    const text = JSON.stringify(res.body);
    for (const forbidden of [
      'idempotencyKey',
      'requestHash',
      'userId',
      'version',
      'paymentRef',
      'cancelReason',
    ])
      expect(text).not.toContain(forbidden);
  });

  it('S10 AS-59: 45 orders with shared instants page 20/20/5 with no repeat or skip, even while new orders arrive; out_of_stock ones are hidden', async () => {
    const buyer = await t.newUser();
    const other = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100 },
    ]);
    const base = t.clock.now().getTime();
    const mine: string[] = (
      await Promise.all(
        Array.from({ length: 45 }, (_, i) =>
          seedPendingOrder(t.app, {
            userId: buyer.id,
            now: new Date(base + Math.floor(i / 3) * 1_000), // three orders share each instant
            lines: [line(products[0].id, shop.id)],
          }),
        ),
      )
    ).map((o) => o.id);
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const o = await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [line(products[0].id, shop.id)],
        });
        await exec(
          t.app,
          `UPDATE "BisOrder" SET "status" = 'CANCELLED', "cancelReason" = 'out_of_stock' WHERE "id" = :id`,
          { id: o.id },
        );
      }),
    );
    await seedPendingOrder(t.app, {
      userId: other.id,
      lines: [line(products[0].id, shop.id)],
    });

    const first = await t.as(buyer).get('/api/orders?limit=20');
    expect(first.status).toBe(200);
    const p1 = orderPageSchema.parse(first.body);
    expect(p1.items).toHaveLength(20);
    // new orders arrive between the pages
    for (let i = 0; i < 3; i += 1)
      await seedPendingOrder(t.app, {
        userId: buyer.id,
        now: new Date(base + 999_000 + i),
        lines: [line(products[0].id, shop.id)],
      });
    const p2 = orderPageSchema.parse(
      (await t.as(buyer).get(`/api/orders?limit=20&cursor=${p1.nextCursor}`))
        .body,
    );
    const p3 = orderPageSchema.parse(
      (await t.as(buyer).get(`/api/orders?limit=20&cursor=${p2.nextCursor}`))
        .body,
    );
    expect([p2.items.length, p3.items.length]).toEqual([20, 5]);
    expect(p3.nextCursor).toBeNull();
    const all = [...idsOf(p1), ...idsOf(p2), ...idsOf(p3)];
    expect(new Set(all).size).toBe(45);
    expect(new Set(all)).toEqual(new Set(mine));
    const sorted = [...p1.items, ...p2.items, ...p3.items];
    for (let i = 1; i < sorted.length; i += 1) {
      const [a, b] = [sorted[i - 1], sorted[i]];
      expect(
        a.createdAt > b.createdAt ||
          (a.createdAt === b.createdAt && a.id > b.id),
      ).toBe(true);
    }
  });

  it('S10 AS-59: default 20, maximum 100, and bad limits or cursors are 400', async () => {
    const buyer = await t.newUser();
    const other = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100 },
    ]);
    await Promise.all(
      Array.from({ length: 22 }, () =>
        seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [line(products[0].id, shop.id)],
        }),
      ),
    );
    await seedPendingOrder(t.app, {
      userId: other.id,
      lines: [line(products[0].id, shop.id)],
    });
    const dflt = await t.as(buyer).get('/api/orders');
    expect(dflt.body.items).toHaveLength(20);
    expect(dflt.body.nextCursor).not.toBeNull();
    const max = await t.as(buyer).get('/api/orders?limit=100');
    expect(max.body.items).toHaveLength(22);
    for (const bad of ['limit=0', 'limit=101', 'limit=abc'])
      expect((await t.as(buyer).get(`/api/orders?${bad}`)).status).toBe(400);
    expect((await t.as(buyer).get('/api/orders?cursor=garbage')).status).toBe(
      400,
    );
    // another buyer's cursor
    const foreign = (await t.as(buyer).get('/api/orders?limit=1')).body
      .nextCursor;
    expect(
      (await t.as(other).get(`/api/orders?cursor=${foreign}`)).status,
    ).toBe(400);
    expect((await t.http().get('/api/orders')).status).toBe(401);
  });

  it('S10 AS-60: the history query is an index-only scan with no sort over 10,000 orders', async () => {
    const buyer = await t.newUser();
    await exec(
      t.app,
      `INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "version", "idempotencyKey", "requestHash", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), :userId, 'PAID', 100, 'USD', 1, 'bulk-' || g, 'x', now() - g * interval '1 second', now()
       FROM generate_series(1, 10000) g`,
      { userId: buyer.id },
    );
    await exec(t.app, `VACUUM (ANALYZE) "BisOrder"`);
    const plan = JSON.stringify(
      await rows(t.app, `EXPLAIN (FORMAT JSON) ${USER_HISTORY_PAGE_SQL}`, {
        userId: buyer.id,
        limit: 21,
        afterCreatedAt: null,
        afterId: null,
      }),
    );
    expect(plan).toContain('Index Only Scan');
    expect(plan).toContain('BisOrder_user_history_v2_idx');
    expect(plan).not.toContain('"Sort"');
  });

  describe('seller list', () => {
    const seed = async () => {
      const buyer = await t.newUser();
      const { shop: s1, products: p1 } = await seedShopWithProducts(t.app, [
        { priceMinor: 500, quantity: 100 },
      ]);
      const { shop: s2, products: p2 } = await seedShopWithProducts(t.app, [
        { priceMinor: 700, quantity: 100 },
      ]);
      const order = await seedPendingOrder(t.app, {
        userId: buyer.id,
        lines: [line(p1[0].id, s1.id, 2), line(p2[0].id, s2.id, 1)],
      });
      return { buyer, s1, s2, p1, p2, order };
    };

    it('S10 AS-61: every role of S1 gets only S1’s slice; S2-only members and non-members get 404; anonymous 401', async () => {
      const { s1, s2, order } = await seed();
      for (const role of ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const) {
        const member = await t.newUser();
        await addMember(t.app, s1.id, member.id, role);
        const res = await t.as(member).get(`/api/shops/${s1.id}/orders`);
        expect(res.status).toBe(200);
        const page = shopOrderPageSchema.parse(res.body);
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          orderId: order.id,
          subtotalMinor: 1_000,
          currency: 'USD',
        });
        expect(page.items[0].items.map((i) => i.shopId)).toEqual([s1.id]);
        expect(JSON.stringify(res.body)).not.toContain(s2.id);
        expect(JSON.stringify(res.body)).not.toContain('1700');
      }
      const s2Only = await t.newUser();
      await addMember(t.app, s2.id, s2Only.id, 'OWNER');
      const denied = await t.as(s2Only).get(`/api/shops/${s1.id}/orders`);
      const stranger = await t.newUser();
      const none = await t.as(stranger).get(`/api/shops/${s1.id}/orders`);
      expect(denied.status).toBe(404);
      expect(none.status).toBe(404);
      expect(denied.body.code).toBe('shop_not_found');
      expect((await t.http().get(`/api/shops/${s1.id}/orders`)).status).toBe(
        401,
      );
    });

    it('S10 AS-61: status filter, keyset pages, bad status or cursor are 400, and a suspended shop still answers the list (S03 R-05, W04 R-03)', async () => {
      const { buyer, s1, p1 } = await seed();
      const member = await t.newUser();
      await addMember(t.app, s1.id, member.id, 'VIEWER');
      const base = t.clock.now().getTime();
      for (let i = 0; i < 4; i += 1)
        await seedPendingOrder(t.app, {
          userId: buyer.id,
          now: new Date(base + i * 1_000),
          lines: [line(p1[0].id, s1.id)],
        });
      await exec(
        t.app,
        `UPDATE "ShopOrder" SET "status" = 'PAID' WHERE "id" IN (SELECT "id" FROM "ShopOrder" WHERE "shopId" = :shopId ORDER BY "createdAt" LIMIT 2)`,
        { shopId: s1.id },
      );
      const paid = shopOrderPageSchema.parse(
        (await t.as(member).get(`/api/shops/${s1.id}/orders?status=PAID`)).body,
      );
      expect(paid.items).toHaveLength(2);
      expect(paid.items.every((i) => i.status === 'PAID')).toBe(true);

      const page = async (cursor: string | null) =>
        shopOrderPageSchema.parse(
          (
            await t
              .as(member)
              .get(
                `/api/shops/${s1.id}/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
              )
          ).body,
        );
      const a = await page(null);
      const b = await page(a.nextCursor);
      const c = await page(b.nextCursor);
      const ids = [...a.items, ...b.items, ...c.items].map(
        (i) => i.shopOrderId,
      );
      expect(new Set(ids).size).toBe(5);
      expect(c.nextCursor).toBeNull();

      expect(
        (await t.as(member).get(`/api/shops/${s1.id}/orders?status=BOGUS`))
          .status,
      ).toBe(400);
      expect(
        (await t.as(member).get(`/api/shops/${s1.id}/orders?cursor=x`)).status,
      ).toBe(400);

      // a shop that is suspended from the start (S03 caches membership for 15 s, so flip no live shop)
      const suspended = await createShop(t.app, null, { status: 'SUSPENDED' });
      await addMember(t.app, suspended.id, member.id, 'OWNER');
      const readable = await t
        .as(member)
        .get(`/api/shops/${suspended.id}/orders`);
      expect(readable.status).toBe(200);
      expect(shopOrderPageSchema.parse(readable.body).items).toEqual([]);
    });
  });

  it('S10 AS-62: getOrdersForShop equals the HTTP page and getOrderLines is one batch with a 500 cap', async () => {
    const buyer = await t.newUser();
    const member = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100 },
      { priceMinor: 300, quantity: 100 },
    ]);
    await addMember(t.app, shop.id, member.id, 'STAFF');
    const o1 = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(products[0].id, shop.id, 2), line(products[1].id, shop.id)],
    });
    const o2 = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(products[1].id, shop.id, 3)],
    });
    const http = await t.as(member).get(`/api/shops/${shop.id}/orders`);
    const direct = await queries.getOrdersForShop(shop.id, { limit: 20 });
    expect(direct).toEqual(http.body);

    const lines = await queries.getOrderLines([o1.id, o2.id, randomUUID()]);
    expect([...lines.keys()].sort()).toEqual([o1.id, o2.id].sort());
    expect(lines.get(o1.id)).toHaveLength(2);
    expect(lines.get(o2.id)![0]).toMatchObject({
      orderId: o2.id,
      productId: products[1].id,
      shopId: shop.id,
      quantity: 3,
      unitPriceMinor: 500,
      discountMinor: 0,
      lineTotalMinor: 1_500,
    });
    expect(typeof lines.get(o2.id)![0].shopOrderId).toBe('string');
    expect(lines.get(o2.id)![0]).not.toHaveProperty('dataValues');
    await expect(
      queries.getOrderLines(Array.from({ length: 501 }, () => randomUUID())),
    ).rejects.toBeInstanceOf(TooManyIdsError);
    await expect(
      queries.getOrderLines(Array.from({ length: 500 }, () => randomUUID())),
    ).resolves.toBeInstanceOf(Map);
  });

  it('S42 AS-42: getShopOrder returns the shop slice with only its lines, and null for another shop’s slice or an unknown id', async () => {
    const buyer = await t.newUser();
    const { shop: s1, products: p1 } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100 },
    ]);
    const { shop: s2, products: p2 } = await seedShopWithProducts(t.app, [
      { priceMinor: 700, quantity: 100 },
    ]);
    await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(p1[0].id, s1.id, 2), line(p2[0].id, s2.id, 1)],
    });
    const page = await queries.getOrdersForShop(s1.id, { limit: 20 });
    const slice = page.items[0];

    const one = await queries.getShopOrder(s1.id, slice.shopOrderId);
    expect(one).toEqual(slice);
    expect(one!.items.map((i) => i.shopId)).toEqual([s1.id]);

    expect(await queries.getShopOrder(s2.id, slice.shopOrderId)).toBeNull();
    expect(await queries.getShopOrder(s1.id, randomUUID())).toBeNull();
  });

  it('S10 AS-63: getPayableOrder returns the allocation for a live RESERVED order and refuses everything else', async () => {
    const buyer = await t.newUser();
    const other = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100 },
    ]);
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [line(products[0].id, shop.id, 2)],
    });
    await expect(
      queries.getPayableOrder(order.id, buyer.id),
    ).rejects.toMatchObject({ reason: 'order_not_reserved' });

    const until = new Date(t.clock.now().getTime() + 15 * 60_000);
    await exec(
      t.app,
      `UPDATE "BisOrder" SET "status" = 'RESERVED', "reservedUntil" = :until WHERE "id" = :id`,
      { id: order.id, until },
    );
    await expect(queries.getPayableOrder(order.id, buyer.id)).resolves.toEqual({
      orderId: order.id,
      userId: buyer.id,
      totalMinor: 1_000,
      currency: 'USD',
      reservedUntil: until.toISOString(),
      shopAllocations: [{ shopId: shop.id, subtotalMinor: 1_000 }],
    });
    await expect(
      queries.getPayableOrder(order.id, other.id),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    await expect(
      queries.getPayableOrder(randomUUID(), buyer.id),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    t.clock.advance(15 * 60_000 + 1);
    const expired = await queries
      .getPayableOrder(order.id, buyer.id)
      .catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(OrderNotPayableError);
    expect(expired).toMatchObject({ reason: 'hold_expired' });

    await exec(
      t.app,
      `UPDATE "BisOrder" SET "status" = 'PAID' WHERE "id" = :id`,
      { id: order.id },
    );
    await expect(
      queries.getPayableOrder(order.id, buyer.id),
    ).rejects.toMatchObject({
      orderStatus: 'PAID',
      reason: 'order_not_reserved',
    });
  });
});
