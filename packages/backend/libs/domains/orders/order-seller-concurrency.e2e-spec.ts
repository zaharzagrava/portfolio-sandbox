import { randomUUID } from 'node:crypto';
import { shopOrderPageSchema } from '@marketplace-sandbox/contracts';
import { addMember } from '@app/test/utils/tenancy-fixtures';
import {
  createOrdersApp,
  exec,
  rows,
  seedPendingOrder,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

/** The seller's order list read while orders arrive, change and are paged in parallel (QA track 3). */
describe('Seller order list under concurrency', () => {
  let t: OrdersTestApp;

  beforeAll(async () => {
    t = await createOrdersApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;

  const world = async (stock = 1_000) => {
    const seller = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 500, quantity: stock },
    ]);
    await addMember(t.app, shop.id, seller.id, 'STAFF');
    const buyer = await t.newUser();
    const order = (at: Date) =>
      seedPendingOrder(t.app, {
        userId: buyer.id,
        now: at,
        lines: [
          {
            productId: products[0].id,
            shopId: shop.id,
            quantity: 1,
            unitPriceMinor: 500,
          },
        ],
      });
    return { seller, shop, product: products[0], buyer, order };
  };
  const list = (seller: User, shopId: string, query = '') =>
    t.as(seller).get(`/api/shops/${shopId}/orders${query}`);
  const walk = async (seller: User, shopId: string, query: string) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(
        seller,
        shopId,
        `?${query}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      const page = shopOrderPageSchema.parse(res.body);
      seen.push(...page.items.map((i) => i.shopOrderId));
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  };
  /** Rows that may never exist whatever the order of the requests. */
  const impossibleOrderRows = async () => ({
    sliceWithoutOrder: await rows(
      t.app,
      `SELECT so."id" FROM "ShopOrder" so WHERE NOT EXISTS (SELECT 1 FROM "BisOrder" o WHERE o."id" = so."bisOrderId")`,
    ),
    subtotalNotLines: await rows(
      t.app,
      `SELECT so."id", so."subtotal", sum(COALESCE(i."lineTotalMinor", i."quantity" * i."priceAtPurchase"))::text AS "lines"
         FROM "ShopOrder" so JOIN "BisOrderItem" i ON i."bisOrderId" = so."bisOrderId" AND i."shopId" = so."shopId"
        GROUP BY so."id", so."subtotal"
       HAVING so."subtotal" <> sum(COALESCE(i."lineTotalMinor", i."quantity" * i."priceAtPurchase"))`,
    ),
    negativeStock: await rows(
      t.app,
      `SELECT "id", "quantity" FROM "Product" WHERE "quantity" < 0`,
    ),
    sliceCancelledOrderNot: await rows(
      t.app,
      `SELECT so."id" FROM "ShopOrder" so JOIN "BisOrder" o ON o."id" = so."bisOrderId"
        WHERE o."status" = 'CANCELLED' AND so."status" <> 'CANCELLED'`,
    ),
    heldReservationOfCancelledOrder: await rows(
      t.app,
      `SELECT r."id" FROM "StockReservation" r JOIN "BisOrder" o ON o."id" = r."bisOrderId"
        WHERE o."status" = 'CANCELLED' AND r."status" = 'HELD'`,
    ),
  });
  const NOTHING = {
    sliceWithoutOrder: [],
    subtotalNotLines: [],
    negativeStock: [],
    sliceCancelledOrderNot: [],
    heldReservationOfCancelledOrder: [],
  };

  it('S10 AS-61: paging 14 slices three at a time while new orders arrive and others turn PAID shows every old slice once and none twice', async () => {
    const { seller, shop, order } = await world();
    const start = t.clock.now().getTime() - 3_600_000;
    for (let i = 0; i < 14; i += 1) await order(new Date(start + i * 1_000));
    const original = (
      await rows<{ id: string }>(
        t.app,
        `SELECT "id" FROM "ShopOrder" WHERE "shopId" = :s`,
        { s: shop.id },
      )
    ).map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let round = 0;
    do {
      const [res] = await Promise.all([
        list(seller, shop.id, `?limit=3${cursor ? `&cursor=${cursor}` : ''}`),
        // between two pages: a newer order, and one old slice that turns PAID
        order(new Date(t.clock.now().getTime() + round * 1_000)),
        exec(
          t.app,
          `UPDATE "ShopOrder" SET "status" = 'PAID' WHERE "id" = (SELECT "id" FROM "ShopOrder" WHERE "shopId" = :s AND "status" = 'PENDING' ORDER BY "createdAt" LIMIT 1)`,
          { s: shop.id },
        ),
      ]);
      expect(res.status).toBe(200);
      const page = shopOrderPageSchema.parse(res.body);
      seen.push(...page.items.map((i) => i.shopOrderId));
      cursor = page.nextCursor;
      round += 1;
    } while (cursor && round < 30);

    expect(new Set(seen).size).toBe(seen.length);
    // every slice that existed before the walk is on some page (new slices sort before the cursor, status does not move a row)
    for (const id of original) expect(seen).toContain(id);
    expect(await impossibleOrderRows()).toEqual(NOTHING);
  });

  it('S10 AS-61: six readers walk 25 slices that share one timestamp at the same time: each sees all 25 once, in the same order', async () => {
    const { seller, shop, order } = await world();
    const same = new Date(t.clock.now().getTime() - 60_000);
    for (let i = 0; i < 25; i += 1) await order(same);

    const walks = await Promise.all(
      Array.from({ length: 6 }, () => walk(seller, shop.id, 'limit=4')),
    );
    for (const seen of walks) {
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual(walks[0]);
    }
  });

  it('S10 AS-61: a status filter walked while slices change status never repeats a slice and never shows another status', async () => {
    const { seller, shop, order } = await world();
    const start = t.clock.now().getTime() - 3_600_000;
    for (let i = 0; i < 12; i += 1) await order(new Date(start + i * 1_000));

    const seen: Array<{ id: string; status: string }> = [];
    let cursor: string | null = null;
    let round = 0;
    do {
      const [res] = await Promise.all([
        list(
          seller,
          shop.id,
          `?status=PENDING&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        ),
        exec(
          t.app,
          `UPDATE "ShopOrder" SET "status" = 'PAID' WHERE "id" = (SELECT "id" FROM "ShopOrder" WHERE "shopId" = :s AND "status" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 1)`,
          { s: shop.id },
        ),
      ]);
      expect(res.status).toBe(200);
      const page = shopOrderPageSchema.parse(res.body);
      seen.push(
        ...page.items.map((i) => ({ id: i.shopOrderId, status: i.status })),
      );
      cursor = page.nextCursor;
      round += 1;
    } while (cursor && round < 30);

    expect(seen.every((s) => s.status === 'PENDING')).toBe(true);
    expect(new Set(seen.map((s) => s.id)).size).toBe(seen.length);
  });

  it('S10 AS-61: sixty parallel reads (list, filtered list, small pages) during new orders all answer 200 with a well-formed page', async () => {
    const { seller, shop, order } = await world();
    for (let i = 0; i < 10; i += 1) await order(new Date(t.clock.now().getTime() - i * 1_000));
    const queries = ['', '?status=PENDING', '?limit=1', '?limit=100', '?status=PAID'];
    const [reads] = await Promise.all([
      Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          list(seller, shop.id, queries[i % queries.length]),
        ),
      ),
      Promise.all(Array.from({ length: 5 }, () => order(t.clock.now()))),
    ]);
    for (const r of reads) {
      expect(r.status).toBe(200);
      shopOrderPageSchema.parse(r.body);
    }
    expect(await impossibleOrderRows()).toEqual(NOTHING);
  });

  it('S10 AS-17: a buyer who double-submits checkout with one key makes one slice for the seller, one stock deduction and no impossible row', async () => {
    const { seller, shop, product } = await world(10);
    const buyer = await t.newUser();
    await t
      .as(buyer)
      .put(`/api/cart/items/${product.id}`)
      .send({ quantity: 2 })
      .expect(200);
    const key = `key-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.as(buyer).post('/api/checkout').set('Idempotency-Key', key).send({}),
      ),
    );
    expect(results.filter((r) => r.status === 202).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 202 || r.status === 409)).toBe(true);

    const page = shopOrderPageSchema.parse(
      (await list(seller, shop.id)).body,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].items[0]).toMatchObject({ quantity: 2 });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 8 });
    expect(await impossibleOrderRows()).toEqual(NOTHING);
  });

  it('S10 AS-31: thirty buyers race for 12 units, each wanting one, while the seller reads: twelve slices, stock 0, never below', async () => {
    const { seller, shop, product } = await world(12);
    const buyers: User[] = [];
    for (let i = 0; i < 30; i += 5)
      buyers.push(...(await Promise.all(Array.from({ length: 5 }, () => t.newUser()))));
    for (let i = 0; i < buyers.length; i += 10)
      await Promise.all(
        buyers.slice(i, i + 10).map((b) =>
          t.as(b).put(`/api/cart/items/${product.id}`).send({ quantity: 1 }).expect(200),
        ),
      );
    const [results, reads] = await Promise.all([
      Promise.all(
        buyers.map((b) =>
          t.as(b).post('/api/checkout').set('Idempotency-Key', `key-${randomUUID()}`).send({}),
        ),
      ),
      Promise.all(Array.from({ length: 10 }, () => list(seller, shop.id))),
    ]);
    expect(results.filter((r) => r.status === 202)).toHaveLength(12);
    for (const r of reads) expect(r.status).toBe(200);

    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 0 });
    // the seller sees the 12 reserved orders; the 18 refused checkouts left cancelled slices at most
    const reserved = await rows<{ n: string }>(
      t.app,
      `SELECT count(*) AS n FROM "BisOrder" o JOIN "ShopOrder" so ON so."bisOrderId" = o."id"
        WHERE so."shopId" = :s AND o."status" = 'RESERVED'`,
      { s: shop.id },
    );
    expect(Number(reserved[0].n)).toBe(12);
    expect(await impossibleOrderRows()).toEqual(NOTHING);
  });
});
