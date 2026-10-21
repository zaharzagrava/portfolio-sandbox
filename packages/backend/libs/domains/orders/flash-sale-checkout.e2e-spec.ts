import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { checkoutResponseSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  createProduct,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import {
  exec,
  rows,
  seedShopWithProducts,
  stockOf,
} from './testing/orders-app';
import {
  createFlashApp,
  seedSeller,
  type FlashTestApp,
  type Seller,
} from './testing/flash-kit';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const DROP_PRICE = 49_900;
const REGULAR_PRICE = 59_900;

describe('Flash sales: reserving drop units, admission and fail-closed', () => {
  let t: FlashTestApp;

  beforeAll(async () => {
    t = await createFlashApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  type User = Awaited<ReturnType<FlashTestApp['newUser']>>;
  interface Drop {
    id: string;
    productId: string;
    seller: Seller;
    units: number;
    buckets: number;
  }

  /**
   * `count` loaded sales (one product each, `regular` units of stock besides the drop) open from T + 10 min: scheduled
   * through the route, loaded by the load handler, the clock then at the start. Users are created afterwards.
   */
  const openDrops = async (
    count: number,
    over: {
      units?: number;
      buckets?: number;
      limit?: number;
      rate?: number;
      regular?: number;
    } = {},
  ): Promise<Drop[]> => {
    const units = over.units ?? 30;
    const buckets = over.buckets ?? 8;
    const regular = over.regular ?? 5;
    t.clock.set(T);
    const seller = await seedSeller(
      t,
      Array.from({ length: count }, () => ({
        priceMinor: REGULAR_PRICE,
        quantity: units + regular,
      })),
    );
    // the sales are for different products, so they can be scheduled 10 at a time
    const drops: Drop[] = [];
    for (let from = 0; from < seller.products.length; from += 10)
      drops.push(
        ...(await Promise.all(
          seller.products.slice(from, from + 10).map(async (product) => {
            const res = await t
              .as(seller.owner)
              .post(`/api/shops/${seller.shop.id}/flash-sales`)
              .send({
                productId: product.id,
                priceMinor: DROP_PRICE,
                units,
                buckets,
                perUserLimit: over.limit ?? 1,
                admissionRatePerSecond: over.rate ?? 2000,
                startsAt: at(10 * MIN).toISOString(),
                endsAt: at(70 * MIN).toISOString(),
              });
            expect(res.status).toBe(201);
            return {
              id: res.body.id as string,
              productId: product.id,
              seller,
              units,
              buckets,
            };
          }),
        )),
      );
    t.clock.set(at(9 * MIN));
    for (let from = 0; from < drops.length; from += 10)
      await Promise.all(
        drops.slice(from, from + 10).map((d) => t.jobs.load({ saleId: d.id })),
      );
    t.clock.set(at(10 * MIN));
    return drops;
  };
  const openDrop = async (over: Parameters<typeof openDrops>[1] = {}) =>
    (await openDrops(1, over))[0];

  const newKey = () => `key-${randomUUID()}`;
  const add = async (user: User, productId: string, quantity: number) => {
    const res = await t
      .as(user)
      .put(`/api/cart/items/${productId}`)
      .send({ quantity });
    expect(res.status).toBe(200);
  };
  const checkout = (user: User, key = newKey(), body?: object) => {
    const req = t.as(user).post('/api/checkout').set('Idempotency-Key', key);
    return body === undefined ? req : req.send(body);
  };
  const cartOf = async (user: User) =>
    Object.fromEntries(
      (
        (await t.as(user).get('/api/cart')).body.lines as Array<{
          productId: string;
          quantity: number;
        }>
      ).map((l) => [l.productId, l.quantity]),
    );
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const count = async (table: string) =>
    Number(
      (
        await rows<{ n: string }>(t.app, `SELECT count(*) AS n FROM "${table}"`)
      )[0].n,
    );
  const reservationsOf = (saleId: string) =>
    rows<{
      status: string;
      source: string;
      quantity: number;
      sourceRef: string;
      bisOrderId: string;
    }>(
      t.app,
      `SELECT "status", "source", "quantity", "sourceRef", "bisOrderId" FROM "StockReservation" WHERE "flashSaleId" = :saleId ORDER BY "createdAt", "id"`,
      { saleId },
    );
  const ordersByStatus = async () =>
    Object.fromEntries(
      (
        await rows<{ status: string; n: string }>(
          t.app,
          `SELECT "status", count(*) AS n FROM "BisOrder" GROUP BY "status"`,
        )
      ).map((r) => [r.status, Number(r.n)]),
    );
  const buyers = (n: number) =>
    Promise.all(Array.from({ length: n }, () => t.newUser()));

  describe('the accepted attempt (AS-01, AS-04, AS-05, AS-07)', () => {
    it('S11 AS-01: 202 at the drop price, one RESERVED order, one HELD drop reservation, a unit less in the buckets, regular stock untouched', async () => {
      const d = await openDrop();
      const user = await t.newUser();
      await add(user, d.productId, 1);

      const res = await checkout(user);
      expect(res.status).toBe(202);
      const answer = checkoutResponseSchema.parse(res.body);
      expect(answer).toMatchObject({
        status: 'RESERVED',
        totalMinor: DROP_PRICE,
      });

      expect(await ordersByStatus()).toEqual({ RESERVED: 1 });
      const [r] = await reservationsOf(d.id);
      expect(r).toMatchObject({ status: 'HELD', source: 'FLASH', quantity: 1 });
      expect(r.bisOrderId).toBe(answer.orderId);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
      expect(await stockOf(t.app, [d.productId])).toEqual({ [d.productId]: 5 });
      expect(await t.quotaOf(d.id, user.id)).toBe(1);
      expect(await cartOf(user)).toEqual({});
      const item = await rows<{
        priceAtPurchase: string;
        discountMinor: string;
      }>(
        t.app,
        `SELECT "priceAtPurchase", "discountMinor" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
        { id: answer.orderId },
      );
      expect(item).toEqual([
        { priceAtPurchase: String(DROP_PRICE), discountMinor: '0' },
      ]);
    });

    it('S11 AS-04: the price comes from the sale, no discount applies, a stale expectedTotalMinor is 409 price_changed', async () => {
      const d = await openDrop({ limit: 2 });
      t.discounts.impl = async () => [
        { shopId: d.seller.shop.id, discountMinor: 10_000 },
      ];
      const user = await t.newUser();
      await add(user, d.productId, 2);

      const stale = await checkout(user, newKey(), {
        expectedTotalMinor: 2 * REGULAR_PRICE,
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        code: 'price_changed',
        currentTotalMinor: 2 * DROP_PRICE,
      });
      expect(await count('BisOrder')).toBe(0);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(30);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);

      const ok = await checkout(user, newKey(), {
        expectedTotalMinor: 2 * DROP_PRICE,
      });
      expect(ok.status).toBe(202);
      expect(ok.body.totalMinor).toBe(99_800);
      const [item] = await rows<{
        priceAtPurchase: string;
        discountMinor: string;
        lineTotalMinor: string;
      }>(
        t.app,
        `SELECT "priceAtPurchase", "discountMinor", "lineTotalMinor" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
        { id: ok.body.orderId },
      );
      expect(item).toEqual({
        priceAtPurchase: '49900',
        discountMinor: '0',
        lineTotalMinor: '99800',
      });
    });

    it('S11 AS-05: a sequential replay answers the same order; one claim, one order, units − 1, quota 1', async () => {
      const d = await openDrop();
      const user = await t.newUser();
      await add(user, d.productId, 1);
      const key = newKey();
      const first = await checkout(user, key);
      const second = await checkout(user, key);
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.orderId).toBe(first.body.orderId);
      expect(await count('BisOrder')).toBe(1);
      expect(await reservationsOf(d.id)).toHaveLength(1);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
      expect(await t.quotaOf(d.id, user.id)).toBe(1);
    });

    it('S11 AS-05: simultaneous replays end with one claim and one order', async () => {
      const d = await openDrop();
      const user = await t.newUser();
      await add(user, d.productId, 1);
      const key = newKey();
      const results = await Promise.all([
        checkout(user, key),
        checkout(user, key),
        checkout(user, key),
      ]);
      for (const r of results) expect([202, 409]).toContain(r.status);
      expect(results.some((r) => r.status === 202)).toBe(true);
      expect(await count('BisOrder')).toBe(1);
      expect(await reservationsOf(d.id)).toHaveLength(1);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
      expect(await t.quotaOf(d.id, user.id)).toBe(1);
    });

    it('S11 AS-07: the per-customer limit: a third unit is 422 flash_sale_limit_exceeded, cancelling frees the quota', async () => {
      const d = await openDrop({ limit: 2 });
      const user = await t.newUser();

      await add(user, d.productId, 3);
      const over = await checkout(user);
      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({
        code: 'flash_sale_limit_exceeded',
        limit: 2,
        flashSaleId: d.id,
      });
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(30);
      expect(await count('BisOrder')).toBe(0);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);

      await add(user, d.productId, 2);
      const first = await checkout(user);
      expect(first.status).toBe(202);
      expect(await t.quotaOf(d.id, user.id)).toBe(2);

      await add(user, d.productId, 1);
      const more = await checkout(user, newKey());
      expect(more.status).toBe(422);
      expect(more.body.code).toBe('flash_sale_limit_exceeded');
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(28);
      expect(await count('BisOrder')).toBe(1);

      const cancel = await t
        .as(user)
        .post(`/api/orders/${first.body.orderId}/cancel`);
      expect(cancel.status).toBe(200);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(30);

      await add(user, d.productId, 2);
      expect((await checkout(user, newKey())).status).toBe(202);
    });
  });

  describe('never oversell (AS-02, AS-03, AS-06)', () => {
    const race = async (drops: Drop[], users: User[], units: number) => {
      for (const d of drops)
        await Promise.all(users.map((u) => add(u, d.productId, 1)));
      return drops;
    };

    it('S11 AS-02: 100 buyers race for 30 units: exactly 30 orders, 70 × 422 out_of_stock, buckets 0 and never negative', async () => {
      const d = await openDrop({ units: 30, buckets: 8 });
      const users = await buyers(100);
      await race([d], users, 30);
      const results = await Promise.all(users.map((u) => checkout(u)));

      const accepted = results.filter((r) => r.status === 202);
      const refused = results.filter((r) => r.status === 422);
      expect(accepted).toHaveLength(30);
      expect(refused).toHaveLength(70);
      for (const r of refused)
        expect(r.body).toMatchObject({
          code: 'out_of_stock',
          productIds: [d.productId],
          flashSaleId: d.id,
        });
      const buckets = await t.buckets(d.id, d.buckets);
      expect(sum(buckets)).toBe(0);
      expect(Math.min(...buckets)).toBeGreaterThanOrEqual(0);
      expect(await count('BisOrder')).toBe(30);
      expect(await reservationsOf(d.id)).toHaveLength(30);
      expect(await stockOf(t.app, [d.productId])).toEqual({ [d.productId]: 5 });
    });

    it('S11 AS-02 (SC-001): 200 buyers for 50 units end with exactly 50 orders', async () => {
      const d = await openDrop({ units: 50, buckets: 16 });
      const users = await buyers(200);
      await race([d], users, 50);
      const results = await Promise.all(users.map((u) => checkout(u)));
      expect(results.filter((r) => r.status === 202)).toHaveLength(50);
      expect(results.filter((r) => r.status === 422)).toHaveLength(150);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(0);
      expect(await count('BisOrder')).toBe(50);
    });

    it('S11 AS-02 (SC-001): the same race gives the same result in 50 repeated runs', async () => {
      const REPS = 50;
      const drops = await openDrops(REPS, { units: 30, buckets: 8 });
      const users = await buyers(100);
      for (const [i, d] of drops.entries()) {
        await t.clearRateLimits();
        await Promise.all(users.map((u) => add(u, d.productId, 1)));
        const results = await Promise.all(users.map((u) => checkout(u)));
        const accepted = results.filter((r) => r.status === 202).length;
        const refused = results.filter((r) => r.status === 422).length;
        if (accepted !== 30 || refused !== 70)
          throw new Error(`run ${i}: ${accepted} accepted, ${refused} refused`);
        const buckets = await t.buckets(d.id, d.buckets);
        if (sum(buckets) !== 0 || Math.min(...buckets) < 0)
          throw new Error(`run ${i}: buckets ${buckets.join(',')}`);
        // the refused buyers keep this drop's line in their carts: empty them for the next run
        await Promise.all(
          users.map((u) =>
            t.as(u).put(`/api/cart/items/${d.productId}`).send({ quantity: 0 }),
          ),
        );
      }
      expect(await count('BisOrder')).toBe(30 * REPS);
    }, 900_000);

    it('S11 AS-03: a purchase of 2 takes from two buckets holding 1 + 1 and a cancel returns 1 + 1', async () => {
      const d = await openDrop({ units: 2, buckets: 2, limit: 2, regular: 5 });
      expect(await t.buckets(d.id, 2)).toEqual([1, 1]);
      const user = await t.newUser();
      await add(user, d.productId, 2);

      const res = await checkout(user);
      expect(res.status).toBe(202);
      expect(await t.buckets(d.id, 2)).toEqual([0, 0]);
      const [row] = await reservationsOf(d.id);
      const plan = JSON.parse(
        (await t.redis.hget(
          `flash:{${d.id}:claim:${row.sourceRef}}`,
          'plan',
        )) as string,
      );
      expect(plan).toEqual(
        expect.arrayContaining([
          { bucket: 0, take: 1 },
          { bucket: 1, take: 1 },
        ]),
      );
      expect(plan).toHaveLength(2);

      expect(
        (await t.as(user).post(`/api/orders/${res.body.orderId}/cancel`))
          .status,
      ).toBe(200);
      expect(await t.buckets(d.id, 2)).toEqual([1, 1]);
    });

    it('S11 AS-03: with 1 + 0 left a purchase of 2 is refused and the unit stays', async () => {
      const d = await openDrop({ units: 2, buckets: 2, limit: 2 });
      await t.redis.set(`flash:{${d.id}:1}:stock`, 0);
      const user = await t.newUser();
      await add(user, d.productId, 2);
      const res = await checkout(user);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('out_of_stock');
      expect(await t.buckets(d.id, 2)).toEqual([1, 0]);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
    });

    it('S11 AS-06: a sold-out refusal is final for the attempt, creates nothing and reads no relational table', async () => {
      const d = await openDrop({ units: 4, buckets: 2 });
      for (let b = 0; b < 2; b++)
        await t.redis.set(`flash:{${d.id}:${b}}:stock`, 0);
      const user = await t.newUser();
      await add(user, d.productId, 1);
      await t.directory.openSalesFor([d.productId], t.clock.now()); // the sale list is warm in the cache

      const before = {
        order: await count('BisOrder'),
        item: await count('BisOrderItem'),
        reservation: await count('StockReservation'),
        history: await count('OrderEvent'),
        outbox: await count('Outbox'),
        job: await count('Job'),
      };
      const { result, statements } = await recordStatements(
        t.app,
        () => checkout(user),
        /./,
      );
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        code: 'out_of_stock',
        productIds: [d.productId],
        flashSaleId: d.id,
      });
      // The route's platform idempotency record (`@Idempotent()`, S10) writes its own table; nothing else is touched.
      expect(statements.filter((s) => !s.includes('"IdempotencyKey"'))).toEqual(
        [],
      );
      expect({
        order: await count('BisOrder'),
        item: await count('BisOrderItem'),
        reservation: await count('StockReservation'),
        history: await count('OrderEvent'),
        outbox: await count('Outbox'),
        job: await count('Job'),
      }).toEqual(before);
      expect(await cartOf(user)).toEqual({ [d.productId]: 1 });
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
    });
  });

  describe('sale window and mixed carts (AS-08, AS-09)', () => {
    it('S11 AS-08: before the start and after the end the regular price and regular stock apply; inside, the drop', async () => {
      const d = await openDrop({ units: 30, regular: 5 });
      const user = await t.newUser();

      const go = async (ms: number) => {
        t.clock.set(at(ms));
        await t.reauth(user);
      };
      await go(10 * MIN - 1_000); // one second before the start
      await add(user, d.productId, 1);
      const before = await checkout(user);
      expect(before.status).toBe(202);
      expect(before.body.totalMinor).toBe(REGULAR_PRICE);
      expect(await stockOf(t.app, [d.productId])).toEqual({ [d.productId]: 4 });
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(30);

      await go(10 * MIN); // exactly at the start
      await add(user, d.productId, 1);
      const during = await checkout(user);
      expect(during.status).toBe(202);
      expect(during.body.totalMinor).toBe(DROP_PRICE);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
      expect(await stockOf(t.app, [d.productId])).toEqual({ [d.productId]: 4 });

      await go(80 * MIN); // ten minutes after the end, the end job has not run
      await add(user, d.productId, 1);
      const after = await checkout(user);
      expect(after.status).toBe(202);
      expect(after.body.totalMinor).toBe(REGULAR_PRICE);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
      expect(await stockOf(t.app, [d.productId])).toEqual({ [d.productId]: 3 });
    });

    it('S11 AS-09: a regular line that is out of stock cancels the order, gives the drop unit back once and frees the quota; a retry without it works', async () => {
      const d = await openDrop({ limit: 1 });
      const other = await seedShopWithProducts(t.app, [
        { priceMinor: 1_000, quantity: 1 },
      ]);
      const b = other.products[0];
      await exec(
        t.app,
        `UPDATE "Product" SET "quantity" = 0 WHERE "id" = :id`,
        { id: b.id },
      );
      const user = await t.newUser();
      await add(user, d.productId, 1);
      await add(user, b.id, 1);

      const res = await checkout(user);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'out_of_stock',
        productIds: [b.id],
      });
      expect(await ordersByStatus()).toEqual({ CANCELLED: 1 });
      const [order] = await rows<{ cancelReason: string }>(
        t.app,
        `SELECT "cancelReason" FROM "BisOrder"`,
      );
      expect(order.cancelReason).toBe('out_of_stock');
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(30);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
      expect((await reservationsOf(d.id)).map((r) => r.status)).toEqual([
        'RELEASED',
      ]);

      await add(user, b.id, 0);
      const retry = await checkout(user);
      expect(retry.status).toBe(202);
      expect(retry.body.totalMinor).toBe(DROP_PRICE);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
    });
  });

  describe('admission (AS-10, AS-11, AS-12)', () => {
    it('S11 AS-10: 300 simultaneous attempts against a rate of 100 admit 100 and refuse 200 with flash_sale_busy and no side effects', async () => {
      const d = await openDrop({
        units: 1000,
        buckets: 8,
        limit: 1,
        rate: 100,
      });
      const users = await buyers(300);
      await Promise.all(users.map((u) => add(u, d.productId, 1)));
      const results = await Promise.all(users.map((u) => checkout(u)));

      const accepted = results.filter((r) => r.status === 202);
      const busy = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(100);
      expect(busy).toHaveLength(200);
      for (const r of busy) {
        expect(r.body).toMatchObject({
          code: 'flash_sale_busy',
          flashSaleId: d.id,
        });
        const retryAfter = Number(r.headers['retry-after']);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(3);
      }
      expect(await count('BisOrder')).toBe(100);
      expect(await reservationsOf(d.id)).toHaveLength(100);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(900);
    });

    it('S11 AS-11: the allowance refills with the clock: +1 s admits 100 more, +10 ms at most 1', async () => {
      const d = await openDrop({
        units: 1000,
        buckets: 8,
        limit: 1,
        rate: 100,
      });
      const users = await buyers(320);
      await Promise.all(users.map((u) => add(u, d.productId, 1)));
      const first = await Promise.all(
        users.slice(0, 100).map((u) => checkout(u)),
      );
      expect(first.filter((r) => r.status === 202)).toHaveLength(100);
      const empty = await checkout(users[100]);
      expect(empty.status).toBe(429);

      t.clock.set(new Date(t.clock.nowMs() + 1_000));
      const second = await Promise.all(
        users.slice(100, 220).map((u) => checkout(u)),
      );
      expect(second.filter((r) => r.status === 202)).toHaveLength(100);
      expect(second.filter((r) => r.status === 429)).toHaveLength(20);

      t.clock.set(new Date(t.clock.nowMs() + 10));
      const third = await Promise.all(
        users.slice(220, 320).map((u) => checkout(u)),
      );
      expect(third.filter((r) => r.status === 202).length).toBeLessThanOrEqual(
        1,
      );
    });

    it('S11 AS-12: the per-buyer attempt allowance (30 per minute per sale) answers 429 rate_limited and takes no unit', async () => {
      const d = await openDrop({ units: 100, limit: 5 });
      const [a, b] = await buyers(2);
      await add(a, d.productId, 1);
      await add(b, d.productId, 1);
      // the route's own policy (checkout.create) is stricter than 30 per minute, so the allowance is used up directly
      const limiter = t.app.get(RateLimiterService);
      for (let i = 0; i < 30; i++)
        expect(
          (await limiter.check('orders.flash-reserve.user', `${a.id}:${d.id}`))
            .allowed,
        ).toBe(true);

      const limited = await checkout(a);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(100);
      expect(await count('BisOrder')).toBe(0);

      expect((await checkout(b)).status).toBe(202);
      expect(sum(await t.buckets(d.id, d.buckets))).toBe(99);
    });
  });

  describe('the fast store is down (AS-13)', () => {
    it.each([
      ['the stock side', { except: 'admission' as const }],
      ['the admission and the stock side', undefined],
    ])(
      'S11 AS-13: %s refusing commands → 503 flash_sale_unavailable, Retry-After 2, no order, no other source; regular-only carts and recovery work',
      async (_name, deny) => {
        const d = await openDrop();
        const regular = await seedShopWithProducts(t.app, [
          { priceMinor: 1_000, quantity: 10 },
        ]);
        const user = await t.newUser();
        const shopper = await t.newUser();
        await add(user, d.productId, 1);
        await add(shopper, regular.products[0].id, 1);
        await t.directory.openSalesFor([d.productId], t.clock.now());

        await t.denyStore(deny);
        const down = await checkout(user);
        expect(down.status).toBe(503);
        expect(down.body.code).toBe('flash_sale_unavailable');
        expect(down.headers['retry-after']).toBe('2');
        expect(await count('BisOrder')).toBe(0);
        expect(await stockOf(t.app, [d.productId])).toEqual({
          [d.productId]: 5,
        });
        expect(await cartOf(user)).toEqual({ [d.productId]: 1 });

        const other = await checkout(shopper);
        expect(other.status).toBe(202);
        expect(await stockOf(t.app, [regular.products[0].id])).toEqual({
          [regular.products[0].id]: 9,
        });

        await t.allowStore();
        const recovered = await checkout(user);
        expect(recovered.status).toBe(202);
        expect(recovered.body.totalMinor).toBe(DROP_PRICE);
        expect(sum(await t.buckets(d.id, d.buckets))).toBe(29);
        expect(await stockOf(t.app, [d.productId])).toEqual({
          [d.productId]: 5,
        });
      },
    );
  });

  // keep helpers referenced for the part-2 scenarios below
  void [outboxRowsFor, createProduct, JobsTestProbe, Sequelize, exec];
});
