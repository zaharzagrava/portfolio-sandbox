import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { orderEventSchemas, orderSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ProductStockService } from '@app/domains/catalog';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { OrderJobs } from './infra/order.jobs';
import {
  createOrdersApp,
  exec,
  historyOf,
  orderRow,
  ordersOf,
  reservationsOf,
  rows,
  seedPendingOrder,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

const MIN = 60_000;
const T = new Date('2026-10-10T12:00:00.000Z');

describe('Checkout: stock reservation, expiry and compensation', () => {
  let t: OrdersTestApp;
  let jobs: OrderJobs;

  beforeAll(async () => {
    t = await createOrdersApp();
    jobs = t.app.get(OrderJobs);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;
  const newKey = () => `key-${randomUUID()}`;
  const checkout = (user: User, key = newKey(), body: object = {}) =>
    t.as(user).post('/api/checkout').set('Idempotency-Key', key).send(body);
  const addToCart = async (
    user: User,
    product: { id: string },
    quantity: number,
  ) => {
    const res = await t
      .as(user)
      .put(`/api/cart/items/${product.id}`)
      .send({ quantity });
    expect(res.status).toBe(200);
  };
  const stockOperations = async (productId: string) =>
    (
      await rows<{ operationId: string; delta: number; reason: string }>(
        t.app,
        `SELECT "operationId", "delta", "reason" FROM "ProductStockOperation" WHERE "productId" = :productId ORDER BY "appliedAt", "operationId"`,
        { productId },
      )
    ).map((o) => ({ ...o, delta: Number(o.delta) }));
  const events = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId))
      .filter((r) => r.kind === 'event')
      .map((r) => r.type);

  /** A buyer with a RESERVED order of `quantity` of one product (stock 10), reserved at `T`. */
  const reservedOrder = async (quantity = 3) => {
    t.clock.set(T);
    const { products } = await seedShopWithProducts(t.app, [
      { priceMinor: 1_000, quantity: 10, currency: 'EUR' },
    ]);
    const product = products[0];
    const user = await t.newUser();
    await addToCart(user, product, quantity);
    const res = await checkout(user);
    expect(res.status).toBe(202);
    return { user, product, orderId: res.body.orderId as string };
  };

  describe('reserving (AS-31 to AS-34)', () => {
    it('S10 AS-31: the catalog gets one command orders:<orderId>:reserve:<product> with delta -3 and reason order.reserve; a replay changes nothing', async () => {
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 1_000, quantity: 10, currency: 'EUR' },
      ]);
      const a = products[0];
      const user = await t.newUser();
      await addToCart(user, a, 3);
      const stock = t.app.get(ProductStockService);
      const seen: Array<
        Array<{ operationId: string; delta: number; reason: string }>
      > = [];
      t.patch(
        stock,
        'applyStockDelta',
        (original) =>
          (async (ops: never[]) => {
            seen.push(ops);
            return original(ops as never);
          }) as never,
      );

      const res = await checkout(user);
      expect(res.status).toBe(202);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual([
        expect.objectContaining({
          operationId: `orders:${res.body.orderId}:reserve:${a.id}`,
          delta: -3,
          reason: 'order.reserve',
          productId: a.id,
        }),
      ]);
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 7 });

      const replay = await stock.applyStockDelta(seen[0] as never);
      expect(replay).toMatchObject({
        outcome: 'applied',
        results: [{ replayed: true }],
      });
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 7 });
    });

    it('S10 AS-31: a product archived after the read refuses the negative delta: 422 product_unavailable and the order is cancelled', async () => {
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 1_000, quantity: 10, currency: 'EUR' },
      ]);
      const a = products[0];
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const stock = t.app.get(ProductStockService);
      t.patch(
        stock,
        'applyStockDelta',
        (original) =>
          (async (ops: never[]) => {
            await exec(
              t.app,
              `UPDATE "Product" SET "status" = 'ARCHIVED' WHERE "id" = :id`,
              { id: a.id },
            );
            return original(ops as never);
          }) as never,
      );
      const res = await checkout(user);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'product_unavailable',
        productIds: [a.id],
      });
      const [order] = await ordersOf(t.app, user.id);
      expect([order.status, order.cancelReason]).toEqual([
        'CANCELLED',
        'out_of_stock',
      ]);
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 10 });
    });

    it('S10 AS-32: 200 buyers at once on 50 units give exactly 50 accepted and 150 out_of_stock, stock 0 and never negative (5 rounds)', async () => {
      jest.setTimeout(600_000);
      const config = t.app.get(ApiConfigService);
      // The race measures the invariant, not latency: keep the call timeouts from turning contention into 503s.
      t.patch(
        config,
        'get',
        (original) =>
          ((key: string) =>
            [
              'orders_stock_timeout_ms',
              'orders_catalog_timeout_ms',
              'orders_checkout_budget_ms',
              'orders_shops_timeout_ms',
              'orders_cart_store_timeout_ms',
              'orders_lock_timeout_ms',
            ].includes(key)
              ? 60_000
              : original(key as never)) as never,
      );
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 100, quantity: 50, currency: 'EUR' },
      ]);
      const a = products[0];
      const buyers: User[] = [];
      for (let i = 0; i < 200; i++) buyers.push(await t.newUser());

      for (let round = 0; round < 5; round++) {
        await exec(
          t.app,
          `UPDATE "Product" SET "quantity" = 50 WHERE "id" = :id`,
          { id: a.id },
        );
        for (let i = 0; i < buyers.length; i += 25)
          await Promise.all(
            buyers.slice(i, i + 25).map((u) => addToCart(u, a, 1)),
          );
        let lowest = 50;
        let polling = true;
        const poll = (async () => {
          while (polling) {
            lowest = Math.min(lowest, (await stockOf(t.app, [a.id]))[a.id]);
            await new Promise((r) => setTimeout(r, 5));
          }
        })();
        const results = await Promise.all(buyers.map((u) => checkout(u)));
        polling = false;
        await poll;

        const accepted = results.filter((r) => r.status === 202);
        const refused = results.filter((r) => r.status === 422);
        expect([round, accepted.length, refused.length]).toEqual([
          round,
          50,
          150,
        ]);
        for (const r of refused)
          expect(r.body).toMatchObject({
            code: 'out_of_stock',
            productIds: [a.id],
          });
        expect(lowest).toBeGreaterThanOrEqual(0);
        expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 0 });
        // every checkout left an order behind: 50 RESERVED, 150 CANCELLED(out_of_stock) that never held anything
        const all = await rows<{
          status: string;
          cancelReason: string | null;
          held: string;
          reserved: string;
        }>(
          t.app,
          `SELECT o."status", o."cancelReason",
                  (SELECT count(*) FROM "StockReservation" r WHERE r."bisOrderId" = o."id" AND r."status" = 'HELD') AS held,
                  (SELECT count(*) FROM "Outbox" x WHERE x."aggregateId" = o."id"::text AND x."type" = 'order.reserved') AS reserved
           FROM "BisOrder" o WHERE o."userId" IN (:users)`,
          { users: buyers.map((b) => b.id) },
        );
        expect(all.filter((o) => o.status === 'RESERVED')).toHaveLength(50);
        const cancelled = all.filter((o) => o.status === 'CANCELLED');
        expect(cancelled).toHaveLength(150);
        expect(
          cancelled.every(
            (o) =>
              o.cancelReason === 'out_of_stock' &&
              o.held === '0' &&
              o.reserved === '0',
          ),
        ).toBe(true);
        // next round starts clean (stock is reset by SQL above)
        await exec(t.app, `DELETE FROM "BisOrder" WHERE "userId" IN (:users)`, {
          users: buyers.map((b) => b.id),
        });
      }
    }, 600_000);

    it('S10 AS-33: a short product means nothing is held: 422 for B, stock A unchanged, CANCELLED(out_of_stock), no HELD reservation, no order.reserved', async () => {
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 100, quantity: 5, currency: 'EUR' },
        { priceMinor: 100, quantity: 1, currency: 'EUR' },
      ]);
      const [a, b] = products;
      const user = await t.newUser();
      await addToCart(user, a, 1);
      await addToCart(user, b, 2);
      const res = await checkout(user);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: 'out_of_stock',
        productIds: [b.id],
      });
      expect(await stockOf(t.app, [a.id, b.id])).toEqual({
        [a.id]: 5,
        [b.id]: 1,
      });
      const [order] = await ordersOf(t.app, user.id);
      expect([order.status, order.cancelReason]).toEqual([
        'CANCELLED',
        'out_of_stock',
      ]);
      expect(
        (await reservationsOf(t.app, order.id)).map((r) => r.status),
      ).toEqual(['RELEASED', 'RELEASED']);
      expect(await events(order.id)).toEqual(['order.cancelled']);
    });

    it('S10 AS-34: 100 + 100 buyers whose carts hold A and B in opposite order all succeed without a 5xx; stocks are consistent', async () => {
      jest.setTimeout(600_000);
      const config = t.app.get(ApiConfigService);
      t.patch(
        config,
        'get',
        (original) =>
          ((key: string) =>
            [
              'orders_stock_timeout_ms',
              'orders_catalog_timeout_ms',
              'orders_checkout_budget_ms',
              'orders_shops_timeout_ms',
              'orders_cart_store_timeout_ms',
              'orders_lock_timeout_ms',
            ].includes(key)
              ? 60_000
              : original(key as never)) as never,
      );
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 100, quantity: 1_000, currency: 'EUR' },
        { priceMinor: 100, quantity: 1_000, currency: 'EUR' },
      ]);
      const [a, b] = products;
      const buyers: User[] = [];
      for (let i = 0; i < 200; i++) buyers.push(await t.newUser());
      for (let i = 0; i < buyers.length; i += 20)
        await Promise.all(
          buyers.slice(i, i + 20).map(async (u, k) => {
            const [first, second] = (i + k) % 2 === 0 ? [a, b] : [b, a];
            await addToCart(u, first, 1);
            t.clock.set(new Date(t.clock.now().getTime() + 1_000));
            await addToCart(u, second, 1);
          }),
        );
      const results = await Promise.all(buyers.map((u) => checkout(u)));
      expect(
        results
          .filter((r) => r.status >= 500)
          .map((r) => [r.status, r.body.code, r.body.detail]),
      ).toEqual([]);
      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(await stockOf(t.app, [a.id, b.id])).toEqual({
        [a.id]: 800,
        [b.id]: 800,
      });
    }, 600_000);
  });

  describe('expiry, sweeper, release and recovery (AS-36 to AS-39)', () => {
    it('S10 AS-36: the expiry job does nothing before the deadline, cancels at it (hold_expired), returns the stock once and is idempotent', async () => {
      const { user, product, orderId } = await reservedOrder(3);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 7 });
      t.realtime.published.length = 0;

      t.clock.set(new Date(T.getTime() + 15 * MIN - 1_000));
      await jobs.expireReservation({ orderId });
      expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');

      t.clock.set(new Date(T.getTime() + 15 * MIN));
      await jobs.expireReservation({ orderId });
      const row = await orderRow(t.app, orderId);
      expect([row.status, row.cancelReason]).toEqual([
        'CANCELLED',
        'hold_expired',
      ]);
      expect(
        (await reservationsOf(t.app, orderId)).map((r) => r.status),
      ).toEqual(['RELEASED']);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(
        (await stockOperations(product.id)).map((o) => o.operationId),
      ).toContain(`orders:${orderId}:release:${product.id}`);
      expect(await events(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect(
        t.realtime.published.filter(
          (p) => (p.data as { status: string }).status === 'CANCELLED',
        ),
      ).toHaveLength(1);
      const cancelled = orderEventSchemas['order.cancelled'].parse(
        (
          (await outboxRowsFor(t.app, orderId)).at(-1)!.payload as {
            payload: unknown;
          }
        ).payload,
      );
      expect(cancelled).toMatchObject({
        reason: 'hold_expired',
        previousStatus: 'RESERVED',
        userId: user.id,
      });

      await jobs.expireReservation({ orderId });
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(await events(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect(
        (await historyOf(t.app, orderId)).filter(
          (h) => h.toStatus === 'CANCELLED',
        ),
      ).toHaveLength(1);
    });

    it('S10 AS-37: with the expiry job lost the sweeper cancels the order once (also run twice at once), takes at most 200 per run and skips unexpired holds', async () => {
      const { orderId: lost, product } = await reservedOrder(1);
      await exec(
        t.app,
        `DELETE FROM "Job" WHERE "type" = 'orders.expire-reservation'`,
      );
      t.clock.set(new Date(T.getTime() + 15 * MIN + 1_000));
      await Promise.all([jobs.sweepExpired(), jobs.sweepExpired()]);
      const row = await orderRow(t.app, lost);
      expect([row.status, row.cancelReason]).toEqual([
        'CANCELLED',
        'hold_expired',
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(await events(lost)).toEqual(['order.reserved', 'order.cancelled']);

      // 250 expired holds and one that is not
      const shop = await seedShopWithProducts(t.app, [
        { priceMinor: 100, quantity: 0, currency: 'EUR' },
      ]);
      const buyer = await t.newUser();
      const lifecycle = t.app.get(OrderLifecycleService);
      const ids: string[] = [];
      for (let i = 0; i < 251; i++) {
        const o = await seedPendingOrder(t.app, {
          userId: buyer.id,
          lines: [
            {
              productId: shop.products[0].id,
              shopId: shop.shop.id,
              quantity: 1,
              unitPriceMinor: 100,
            },
          ],
        });
        const until =
          i === 250
            ? new Date(t.clock.now().getTime() + 5 * MIN)
            : new Date(t.clock.now().getTime() - 1_000);
        await lifecycle.transition(
          o.id,
          { type: 'reserve' },
          { actor: 'system:test', reservedUntil: until },
        );
        ids.push(o.id);
      }
      const statuses = async () =>
        (
          await rows<{ status: string; n: string }>(
            t.app,
            `SELECT "status", count(*) AS n FROM "BisOrder" WHERE "id" IN (:ids) GROUP BY 1`,
            { ids },
          )
        ).reduce<Record<string, number>>(
          (acc, r) => ({ ...acc, [r.status]: Number(r.n) }),
          {},
        );
      await jobs.sweepExpired();
      expect(await statuses()).toEqual({ CANCELLED: 200, RESERVED: 51 });
      await jobs.sweepExpired();
      expect(await statuses()).toEqual({ CANCELLED: 250, RESERVED: 1 });
    }, 180_000);

    it('S10 AS-38: a failed stock release leaves RELEASE_PENDING and a gauge of 1; the job restores the stock once; a lost answer is replayed, not added twice', async () => {
      const { orderId, product } = await reservedOrder(3);
      const stock = t.app.get(ProductStockService);
      let failures = 1;
      const restore = t.patch(
        stock,
        'applyStockDelta',
        (original) =>
          (async (ops: Array<{ delta: number }>) => {
            if (ops[0].delta > 0 && failures > 0) {
              failures -= 1;
              throw new Error('stock service hiccup');
            }
            return original(ops as never);
          }) as never,
      );

      t.clock.set(new Date(T.getTime() + 15 * MIN));
      await jobs.expireReservation({ orderId });
      const row = await orderRow(t.app, orderId);
      expect([row.status, row.cancelReason]).toEqual([
        'CANCELLED',
        'hold_expired',
      ]);
      expect(
        (await reservationsOf(t.app, orderId)).map((r) => r.status),
      ).toEqual(['RELEASE_PENDING']);
      expect(MetricsRegistry.value('orders_reservations_release_pending')).toBe(
        1,
      );
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 7 });

      restore();
      t.clock.set(new Date(T.getTime() + 16 * MIN));
      await jobs.releaseStock();
      expect(
        (await reservationsOf(t.app, orderId)).map((r) => r.status),
      ).toEqual(['RELEASED']);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(MetricsRegistry.value('orders_reservations_release_pending')).toBe(
        0,
      );

      // lost answer: the first release reaches the catalog, its reply never arrives
      const second = await reservedOrder(2);
      let lose = true;
      const restore2 = t.patch(
        stock,
        'applyStockDelta',
        (original) =>
          (async (ops: Array<{ delta: number }>) => {
            const result = await original(ops as never);
            if (ops[0].delta > 0 && lose) {
              lose = false;
              throw new Error('answer lost');
            }
            return result;
          }) as never,
      );
      t.clock.set(new Date(T.getTime() + 15 * MIN));
      await jobs.expireReservation({ orderId: second.orderId });
      expect(
        (await reservationsOf(t.app, second.orderId)).map((r) => r.status),
      ).toEqual(['RELEASE_PENDING']);
      restore2();
      t.clock.set(new Date(T.getTime() + 20 * MIN));
      await jobs.releaseStock();
      expect(
        (await reservationsOf(t.app, second.orderId)).map((r) => r.status),
      ).toEqual(['RELEASED']);
      const finalStock = (await stockOf(t.app, [second.product.id]))[
        second.product.id
      ];
      expect(finalStock).toBe(10);
    });

    it('S10 AS-39: a PENDING order older than 60 s is recovered with the same operation ids (also when the first attempt applied); a young one is left alone; runs are safe twice and in parallel', async () => {
      t.clock.set(T);
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 100, quantity: 10, currency: 'EUR' },
        { priceMinor: 100, quantity: 1, currency: 'EUR' },
      ]);
      const [plenty, scarce] = products;
      const user = await t.newUser();
      const stock = t.app.get(ProductStockService);

      // (a) the process died after the stock command applied: answer lost
      await addToCart(user, plenty, 2);
      const restore = t.patch(
        stock,
        'applyStockDelta',
        (original) =>
          (async (ops: never[]) => {
            await original(ops as never);
            throw new Error('crashed after applying');
          }) as never,
      );
      const crashed = await checkout(user);
      expect(crashed.status).toBe(503);
      restore();
      const [stuck] = await ordersOf(t.app, user.id);
      expect(stuck.status).toBe('PENDING');
      expect(await stockOf(t.app, [plenty.id])).toEqual({ [plenty.id]: 8 });

      // (b) pending orders whose stock is gone
      const gone = await seedPendingOrder(t.app, {
        userId: user.id,
        lines: [
          {
            productId: scarce.id,
            shopId: scarce.shopId,
            quantity: 5,
            unitPriceMinor: 100,
          },
        ],
      });

      // (c) a young one stays
      t.clock.set(new Date(T.getTime() + 61_000));
      const young = await seedPendingOrder(t.app, {
        userId: user.id,
        lines: [
          {
            productId: plenty.id,
            shopId: plenty.shopId,
            quantity: 1,
            unitPriceMinor: 100,
          },
        ],
      });

      await Promise.all([jobs.recoverPending(), jobs.recoverPending()]);
      await jobs.recoverPending();
      const recovered = await orderRow(t.app, stuck.id);
      expect(recovered.status).toBe('RESERVED');
      expect(
        (await stockOperations(plenty.id)).map((o) => [
          o.operationId.replace(/[0-9a-f-]{36}/g, '#'),
          o.delta,
        ]),
      ).toEqual([['orders:#:reserve:#', -2]]);
      expect(await stockOf(t.app, [plenty.id])).toEqual({ [plenty.id]: 8 });
      const unsold = await orderRow(t.app, gone.id);
      expect([unsold.status, unsold.cancelReason]).toEqual([
        'CANCELLED',
        'out_of_stock',
      ]);
      expect((await orderRow(t.app, young.id)).status).toBe('PENDING');
      expect(await events(stuck.id)).toEqual(['order.reserved']);
    });
  });

  describe('buyer cancels (AS-40)', () => {
    it('S10 AS-40: the buyer’s cancel is 200 with the order, user_cancelled, stock back once and one order.cancelled; another user gets 404 and nothing changes', async () => {
      const { user, product, orderId } = await reservedOrder(3);
      const stranger = await t.newUser();
      const denied = await t.as(stranger).post(`/api/orders/${orderId}/cancel`);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('order_not_found');
      expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 7 });

      const res = await t.as(user).post(`/api/orders/${orderId}/cancel`);
      expect(res.status).toBe(200);
      const body = orderSchema.parse(res.body);
      expect(body).toMatchObject({ id: orderId, status: 'CANCELLED' });
      expect(body.timeline.at(-1)).toMatchObject({
        status: 'CANCELLED',
        reason: 'user_cancelled',
      });
      const row = await orderRow(t.app, orderId);
      expect([row.status, row.cancelReason]).toEqual([
        'CANCELLED',
        'user_cancelled',
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(await events(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);

      const again = await t.as(user).post(`/api/orders/${orderId}/cancel`);
      expect(again.status).toBe(200);
      expect(await events(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
    });
  });
});
