import { randomUUID } from 'node:crypto';
import { shopOrderPageSchema } from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createOrdersApp,
  orderRow,
  seedPendingOrder,
  seedShopWithProducts,
  type OrdersTestApp,
} from './testing/orders-app';

const UNKNOWN_SHOP = '00000000-0000-4000-8000-0000000000ee';

/** Seller A against seller B on the order routes a seller page uses (QA track 4). */
describe('Seller order isolation', () => {
  let t: OrdersTestApp;

  beforeAll(async () => {
    t = await createOrdersApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;
  const stable = ({
    requestId,
    instance,
    traceId,
    ...rest
  }: Record<string, unknown>) => {
    void requestId;
    void instance;
    void traceId;
    return rest;
  };

  /** Two shops, a seller in each, and a buyer with one order that holds a line from each shop. */
  const marketplace = async () => {
    const sellerA = await t.newUser();
    const sellerB = await t.newUser();
    const buyer = await t.newUser();
    const a = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: 100, title: 'Alpha lamp' },
    ]);
    const b = await seedShopWithProducts(t.app, [
      { priceMinor: 7_000, quantity: 100, title: 'Bravo secret' },
    ]);
    await addMember(t.app, a.shop.id, sellerA.id, 'OWNER');
    await addMember(t.app, b.shop.id, sellerB.id, 'OWNER');
    const shared = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [
        {
          productId: a.products[0].id,
          shopId: a.shop.id,
          quantity: 2,
          unitPriceMinor: 500,
          title: 'Alpha lamp',
        },
        {
          productId: b.products[0].id,
          shopId: b.shop.id,
          quantity: 3,
          unitPriceMinor: 7_000,
          title: 'Bravo secret',
        },
      ],
    });
    const onlyB = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [
        {
          productId: b.products[0].id,
          shopId: b.shop.id,
          quantity: 1,
          unitPriceMinor: 7_000,
          title: 'Bravo secret',
        },
      ],
    });
    return { sellerA, sellerB, buyer, a, b, shared, onlyB };
  };
  const list = (user: User, shopId: string, query = '') =>
    t.as(user).get(`/api/shops/${shopId}/orders${query}`);

  it('S10 AS-61: seller A reads shop B’s orders: the same 404 as for an unknown shop, with no sign of shop B in the answer', async () => {
    const { sellerA, b } = await marketplace();
    const foreign = await list(sellerA, b.shop.id);
    const unknown = await list(sellerA, UNKNOWN_SHOP);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('shop_not_found');
    expect(stable(foreign.body)).toEqual(stable(unknown.body));
    expect(JSON.stringify(foreign.body)).not.toMatch(/Bravo/);
    for (const query of ['?status=PAID', '?limit=1', '?limit=100'])
      expect((await list(sellerA, b.shop.id, query)).status).toBe(404);
  });

  it('S10 AS-61: an order with lines from two shops shows each seller only their own slice: no line, title, product, subtotal or total of the other shop', async () => {
    const { sellerA, sellerB, a, b, shared } = await marketplace();

    const asA = await list(sellerA, a.shop.id);
    expect(asA.status).toBe(200);
    const pageA = shopOrderPageSchema.parse(asA.body);
    expect(pageA.items).toHaveLength(1);
    expect(pageA.items[0]).toMatchObject({
      orderId: shared.id,
      subtotalMinor: 1_000,
    });
    expect(pageA.items[0].items.map((i) => i.shopId)).toEqual([a.shop.id]);
    const textA = JSON.stringify(asA.body);
    for (const leak of [b.shop.id, b.products[0].id, 'Bravo'])
      expect(textA).not.toContain(leak);
    // the order total (both shops added up) is not part of a seller's slice
    expect(textA).not.toContain('21000');
    expect(pageA.items[0]).not.toHaveProperty('totalMinor');

    const asB = await list(sellerB, b.shop.id);
    const pageB = shopOrderPageSchema.parse(asB.body);
    expect(pageB.items).toHaveLength(2);
    expect(pageB.items.every((i) => i.items.every((l) => l.shopId === b.shop.id))).toBe(true);
    const textB = JSON.stringify(asB.body);
    for (const leak of [a.shop.id, a.products[0].id, 'Alpha', '"subtotalMinor":1000'])
      expect(textB).not.toContain(leak);
  });

  it('S10 AS-61: a shop that has no orders answers an empty page, not the orders of another shop', async () => {
    const { buyer } = await marketplace();
    void buyer;
    const lonely = await t.newUser();
    const empty = await createShop(t.app, lonely);
    const res = await list(lonely, empty.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('S10 AS-61: every status filter and page size on shop A returns slices of shop A only', async () => {
    const { sellerA, a, b, buyer } = await marketplace();
    for (let i = 0; i < 6; i += 1) {
      await seedPendingOrder(t.app, {
        userId: buyer.id,
        lines: [
          { productId: a.products[0].id, shopId: a.shop.id, quantity: 1, unitPriceMinor: 500 },
          { productId: b.products[0].id, shopId: b.shop.id, quantity: 1, unitPriceMinor: 7_000 },
        ],
      });
    }
    for (const query of [
      '',
      '?limit=2',
      '?limit=100',
      '?status=PENDING',
      '?status=PAID',
      '?status=CANCELLED',
      '?status=REFUNDED',
    ]) {
      const res = await list(sellerA, a.shop.id, query);
      expect(res.status).toBe(200);
      const page = shopOrderPageSchema.parse(res.body);
      for (const item of page.items)
        expect(item.items.every((l) => l.shopId === a.shop.id)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain(b.shop.id);
    }
  });

  describe('cursors', () => {
    it('S10 D-10: a cursor issued for shop B is 400 invalid_cursor on shop A, even for a seller who belongs to both shops', async () => {
      const { sellerA, sellerB, a, b, buyer } = await marketplace();
      const both = await t.newUser();
      await addMember(t.app, a.shop.id, both.id, 'STAFF');
      await addMember(t.app, b.shop.id, both.id, 'STAFF');
      for (let i = 0; i < 4; i += 1)
        await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [
            { productId: a.products[0].id, shopId: a.shop.id, quantity: 1, unitPriceMinor: 500 },
            { productId: b.products[0].id, shopId: b.shop.id, quantity: 1, unitPriceMinor: 7_000 },
          ],
        });

      const fromB = await list(sellerB, b.shop.id, '?limit=2');
      expect(fromB.body.nextCursor).toEqual(expect.any(String));
      const viaOwn = await list(both, a.shop.id, `?limit=2&cursor=${fromB.body.nextCursor}`);
      expect(viaOwn.status).toBe(400);
      expect(viaOwn.body.code).toBe('invalid_cursor');
      expect(JSON.stringify(viaOwn.body)).not.toContain('Bravo');

      // the same holds in the other direction and with a status filter
      const fromA = await list(sellerA, a.shop.id, '?limit=2&status=PENDING');
      const crossed = await list(both, b.shop.id, `?limit=2&status=PENDING&cursor=${fromA.body.nextCursor}`);
      expect(crossed.status).toBe(400);
      expect(crossed.body.code).toBe('invalid_cursor');
    });

    it('S10 D-10: the cursor of shop A given to seller A on shop B’s address is the shop 404, not a cursor error and not a page', async () => {
      const { sellerA, a, b, buyer } = await marketplace();
      for (let i = 0; i < 3; i += 1)
        await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [{ productId: a.products[0].id, shopId: a.shop.id, quantity: 1, unitPriceMinor: 500 }],
        });
      const mine = await list(sellerA, a.shop.id, '?limit=1');
      const res = await list(sellerA, b.shop.id, `?limit=1&cursor=${mine.body.nextCursor}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
    });

    it('S10 D-10: a cursor issued for a buyer’s own order list does not open the seller list', async () => {
      const { sellerA, a, b, buyer } = await marketplace();
      for (let i = 0; i < 3; i += 1)
        await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [{ productId: b.products[0].id, shopId: b.shop.id, quantity: 1, unitPriceMinor: 7_000 }],
        });
      const buyerPage = await t.as(buyer).get('/api/orders?limit=1').expect(200);
      expect(buyerPage.body.nextCursor).toEqual(expect.any(String));
      const res = await list(sellerA, a.shop.id, `?limit=1&cursor=${buyerPage.body.nextCursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    });
  });

  describe('roles and the buyer side', () => {
    it('S10 AS-58: a seller reading a buyer’s order id gets the same 404 as for a random id, and cannot cancel it', async () => {
      const { sellerA, sellerB, shared, onlyB } = await marketplace();
      for (const who of [sellerA, sellerB]) {
        for (const id of [shared.id, onlyB.id]) {
          const foreign = await t.as(who).get(`/api/orders/${id}`);
          const unknown = await t.as(who).get(`/api/orders/${randomUUID()}`);
          expect(foreign.status).toBe(404);
          expect(stable(foreign.body)).toEqual(stable(unknown.body));
          const cancel = await t.as(who).post(`/api/orders/${id}/cancel`).send({});
          expect(cancel.status).toBe(404);
        }
      }
      expect(await orderRow(t.app, shared.id)).toMatchObject({ status: 'PENDING', version: 1 });
      expect(await orderRow(t.app, onlyB.id)).toMatchObject({ status: 'PENDING', version: 1 });
    });

    it('S10 AS-58: the buyer’s own order list never shows another buyer’s orders, and a seller’s list has none of the shop’s orders', async () => {
      const { sellerA, sellerB, buyer } = await marketplace();
      const mine = await t.as(buyer).get('/api/orders').expect(200);
      expect(mine.body.items.length).toBeGreaterThan(0);
      for (const seller of [sellerA, sellerB]) {
        const res = await t.as(seller).get('/api/orders').expect(200);
        expect(res.body.items).toEqual([]);
      }
    });

    it('S10 AS-61: viewer and staff of shop A read shop A and nothing of shop B; no token is 401', async () => {
      const { a, b } = await marketplace();
      for (const role of ['VIEWER', 'STAFF', 'ADMIN'] as const) {
        const member = await t.newUser();
        await addMember(t.app, a.shop.id, member.id, role);
        expect((await list(member, a.shop.id)).status).toBe(200);
        expect((await list(member, b.shop.id)).status).toBe(404);
      }
      expect((await t.http().get(`/api/shops/${a.shop.id}/orders`)).status).toBe(401);
      expect((await t.http().get(`/api/shops/${b.shop.id}/orders`)).status).toBe(401);
    });

    it('S10 AS-61: the X-Shop-Id header cannot swap the shop: naming shop B on shop A’s path is shop_mismatch', async () => {
      const { sellerA, a, b } = await marketplace();
      const res = await t
        .as(sellerA)
        .get(`/api/shops/${a.shop.id}/orders`)
        .set('X-Shop-Id', b.shop.id);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('shop_mismatch');
      expect(JSON.stringify(res.body)).not.toContain('Bravo');
    });

    it('S10 AS-61: a member removed from shop A can no longer list its orders', async () => {
      const { sellerA, a } = await marketplace();
      const leaver = await t.newUser();
      await addMember(t.app, a.shop.id, leaver.id, 'STAFF');
      expect((await list(leaver, a.shop.id)).status).toBe(200);
      await t.as(sellerA).delete(`/api/shops/${a.shop.id}/members/${leaver.id}`).expect(204);
      const res = await list(leaver, a.shop.id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('shop_not_found');
    });

    it('S10 AS-61: a malformed shop id is 404 shop_not_found, whatever the query', async () => {
      const { sellerA } = await marketplace();
      for (const id of ['not-a-uuid', '123', `${UNKNOWN_SHOP}x`]) {
        const res = await list(sellerA, id, '?limit=1');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('shop_not_found');
      }
    });
  });

  describe('closed shops (S03 FR-013, W04 R-03: orders.read stays allowed while suspended or closing)', () => {
    it.each([
      ['SUSPENDED', 200, undefined],
      ['DELETING', 200, undefined],
      ['DELETED', 404, 'shop_not_found'],
    ] as const)(
      'S10 AS-61: a %s shop answers its own members %i %s and a stranger the plain 404',
      async (status, http, code) => {
        const { sellerA, buyer } = await marketplace();
        const owner = await t.newUser();
        const viewer = await t.newUser();
        const closed = await seedShopWithProducts(
          t.app,
          [{ priceMinor: 900, quantity: 5, title: 'Closed shop item' }],
          { status },
        );
        await addMember(t.app, closed.shop.id, owner.id, 'OWNER');
        await addMember(t.app, closed.shop.id, viewer.id, 'VIEWER');
        await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [{ productId: closed.products[0].id, shopId: closed.shop.id, quantity: 1, unitPriceMinor: 900, title: 'Closed shop item' }],
        });

        for (const member of [owner, viewer]) {
          const res = await list(member, closed.shop.id);
          expect(res.status).toBe(http);
          if (code) {
            expect(res.body.code).toBe(code);
            expect(JSON.stringify(res.body)).not.toContain('Closed shop item');
          }
        }
        const stranger = await list(sellerA, closed.shop.id);
        expect(stranger.status).toBe(404);
        expect(stranger.body.code).toBe('shop_not_found');
      },
    );
  });
});
