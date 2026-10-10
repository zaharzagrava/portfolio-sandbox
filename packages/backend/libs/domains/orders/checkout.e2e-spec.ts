import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import {
  checkoutResponseSchema,
  orderEventSchemas,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ProductQueryService, ProductStockService } from '@app/domains/catalog';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { CART_STORE, type CartStore } from './domain/ports';
import { OrderJobs } from './infra/order.jobs';
import {
  createGate,
  createOrdersApp,
  exec,
  historyOf,
  orderRow,
  ordersOf,
  reservationsOf,
  rows,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

const MIN = 60_000;
const T = new Date('2026-10-10T12:00:00.000Z');

describe('Checkout: idempotency, validation, pricing and split', () => {
  let t: OrdersTestApp;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createOrdersApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;
  const newKey = () => `key-${randomUUID()}`;
  const checkout = (user: User, key: string, body?: object) => {
    const req = t.as(user).post('/api/checkout').set('Idempotency-Key', key);
    return body === undefined ? req : req.send(body);
  };
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
  const cartOf = async (user: User) =>
    Object.fromEntries(
      (
        (await t.as(user).get('/api/cart')).body.lines as Array<{
          productId: string;
          quantity: number;
        }>
      ).map((l) => [l.productId, l.quantity]),
    );
  const orderCount = async (user: User) =>
    (await ordersOf(t.app, user.id)).length;

  /** Shops S1 (A: 1000, stock 10) and S2 (B: 500, stock 4), prices in EUR, as in the spec's AS-13. */
  const standard = async () => {
    const s1 = await seedShopWithProducts(t.app, [
      { title: 'Product A', priceMinor: 1_000, quantity: 10, currency: 'EUR' },
    ]);
    const s2 = await seedShopWithProducts(t.app, [
      { title: 'Product B', priceMinor: 500, quantity: 4, currency: 'EUR' },
    ]);
    return { s1, s2, a: s1.products[0], b: s2.products[0] };
  };

  describe('the accepted checkout (AS-13 to AS-15)', () => {
    it('S10 AS-13: 202 with Location and the full effect: order, snapshots, shop orders, reservations, stock, history, event, expiry job, push, empty cart', async () => {
      t.clock.set(T);
      const { s1, s2, a, b } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 2);
      await addToCart(user, b, 1);

      const res = await checkout(user, 'k-0001-abcd', {
        expectedTotalMinor: 2_500,
      });
      expect(res.status).toBe(202);
      const answer = checkoutResponseSchema.parse(res.body);
      expect(res.headers.location).toBe(`/api/orders/${answer.orderId}`);
      expect(answer).toEqual({
        orderId: answer.orderId,
        status: 'RESERVED',
        totalMinor: 2_500,
        currency: 'EUR',
        reservedUntil: new Date(T.getTime() + 15 * MIN).toISOString(),
      });

      const orders = await ordersOf(t.app, user.id);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        id: answer.orderId,
        status: 'RESERVED',
        version: 2,
        total: '2500',
        currency: 'EUR',
      });

      const items = await rows<{
        title: string;
        shopId: string;
        quantity: number;
        priceAtPurchase: string;
        discountMinor: string;
        lineTotalMinor: string;
      }>(
        t.app,
        `SELECT "title", "shopId", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor" FROM "BisOrderItem" WHERE "bisOrderId" = :id ORDER BY "title"`,
        { id: answer.orderId },
      );
      expect(items).toEqual([
        {
          title: 'Product A',
          shopId: s1.shop.id,
          quantity: 2,
          priceAtPurchase: '1000',
          discountMinor: '0',
          lineTotalMinor: '2000',
        },
        {
          title: 'Product B',
          shopId: s2.shop.id,
          quantity: 1,
          priceAtPurchase: '500',
          discountMinor: '0',
          lineTotalMinor: '500',
        },
      ]);
      const shopOrders = await rows<{
        shopId: string;
        subtotal: string;
        status: string;
      }>(
        t.app,
        `SELECT "shopId", "subtotal", "status" FROM "ShopOrder" WHERE "bisOrderId" = :id ORDER BY "subtotal" DESC`,
        { id: answer.orderId },
      );
      expect(shopOrders).toEqual([
        { shopId: s1.shop.id, subtotal: '2000', status: 'PENDING' },
        { shopId: s2.shop.id, subtotal: '500', status: 'PENDING' },
      ]);
      const reservations = await rows<{ status: string; expiresAt: Date }>(
        t.app,
        `SELECT "status", "expiresAt" FROM "StockReservation" WHERE "bisOrderId" = :id`,
        { id: answer.orderId },
      );
      expect(reservations.map((r) => r.status)).toEqual(['HELD', 'HELD']);
      expect(
        reservations.every(
          (r) => r.expiresAt.getTime() === T.getTime() + 15 * MIN,
        ),
      ).toBe(true);
      expect(await stockOf(t.app, [a.id, b.id])).toEqual({
        [a.id]: 8,
        [b.id]: 3,
      });

      const history = await historyOf(t.app, answer.orderId);
      expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
        [null, 'PENDING'],
        ['PENDING', 'RESERVED'],
      ]);
      const events = (await outboxRowsFor(t.app, answer.orderId)).filter(
        (r) => r.kind === 'event',
      );
      expect(events.map((e) => e.type)).toEqual(['order.reserved']);
      const payload = orderEventSchemas['order.reserved'].parse(
        (events[0].payload as { payload: unknown }).payload,
      );
      expect(payload).toMatchObject({
        orderId: answer.orderId,
        userId: user.id,
        totalMinor: 2_500,
        orderVersion: 2,
      });

      const jobs = await probe.find('orders.expire-reservation', {
        orderId: answer.orderId,
      });
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].runAt).getTime()).toBe(T.getTime() + 15 * MIN);
      expect(t.realtime.published).toContainEqual({
        topic: `user:${user.id}`,
        type: 'order.status',
        data: { orderId: answer.orderId, status: 'RESERVED' },
      });
      expect(await cartOf(user)).toEqual({});
    });

    it('S10 AS-14: prices come from the server; expectedTotalMinor mismatch is 409 price_changed and creates nothing; the key stays usable; unknown properties are 400', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 2);
      await exec(
        t.app,
        `UPDATE "Product" SET "priceMinor" = 1200 WHERE "id" = :id`,
        { id: a.id },
      );

      const key = newKey();
      const mismatch = await checkout(user, key, { expectedTotalMinor: 2_000 });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body).toMatchObject({
        code: 'price_changed',
        currentTotalMinor: 2_400,
        lines: [{ productId: a.id, unitPriceMinor: 1_200 }],
      });
      expect(await orderCount(user)).toBe(0);
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 10 });
      expect(await cartOf(user)).toEqual({ [a.id]: 2 });

      const retry = await checkout(user, key, { expectedTotalMinor: 2_400 });
      expect(retry.status).toBe(202);
      expect(retry.body.totalMinor).toBe(2_400);

      const noExpectation = await t.newUser();
      await addToCart(noExpectation, a, 1);
      const served = await checkout(noExpectation, newKey());
      expect(served.status).toBe(202);
      expect(served.body.totalMinor).toBe(1_200);

      const extra = await t.newUser();
      await addToCart(extra, a, 1);
      for (const body of [
        { items: [] },
        { unitPriceMinor: 1 },
        { expectedTotalMinor: 1_200, other: 1 },
        { expectedTotalMinor: -1 },
        { expectedTotalMinor: 1.5 },
      ]) {
        const res = await checkout(extra, newKey(), body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(await orderCount(extra)).toBe(0);
    });

    it('S10 AS-15: the same key and body after the order became PAID replays the original answer byte for byte; nothing is created; the new cart line stays', async () => {
      const { a, b } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const key = newKey();
      const first = await checkout(user, key, { expectedTotalMinor: 1_000 });
      expect(first.status).toBe(202);
      await t.app
        .get(OrderLifecycleService)
        .transition(
          first.body.orderId,
          { type: 'markPaid', paymentRef: 'pi_1' },
          { actor: 'system:test' },
        );
      await addToCart(user, b, 1);
      const eventsBefore = (await outboxRowsFor(t.app, first.body.orderId))
        .length;

      const again = await checkout(user, key, { expectedTotalMinor: 1_000 });
      expect(again.status).toBe(202);
      expect(again.text).toBe(first.text);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.headers.location).toBe(first.headers.location);
      expect(await orderCount(user)).toBe(1);
      expect((await outboxRowsFor(t.app, first.body.orderId)).length).toBe(
        eventsBefore,
      );
      expect(await stockOf(t.app, [a.id, b.id])).toEqual({
        [a.id]: 9,
        [b.id]: 4,
      });
      expect(await cartOf(user)).toEqual({ [b.id]: 1 });
    });
  });

  describe('duplicates and key rules (AS-16 to AS-20)', () => {
    it('S10 AS-16: a request paused inside the stock step makes the same key 409 idempotency_in_flight with Retry-After 1; afterwards the key replays 202', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const gate = createGate();
      t.patch(
        t.app.get(ProductStockService),
        'applyStockDelta',
        (original) =>
          (async (ops: never) => {
            await gate.wait();
            return original(ops);
          }) as never,
      );

      const key = newKey();
      const first = checkout(user, key, { expectedTotalMinor: 1_000 }).then(
        (r) => r,
      );
      await gate.reached;
      const second = await checkout(user, key, { expectedTotalMinor: 1_000 });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_flight');
      expect(second.headers['retry-after']).toBe('1');

      gate.open();
      const done = await first;
      expect(done.status).toBe(202);
      const third = await checkout(user, key, { expectedTotalMinor: 1_000 });
      expect(third.status).toBe(202);
      expect(third.body.orderId).toBe(done.body.orderId);
      expect(await orderCount(user)).toBe(1);
    });

    it('S10 AS-17: five identical requests at once give one order, one stock deduction, and only 202 (same id) or 409 in flight', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 2);
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          checkout(user, key, { expectedTotalMinor: 2_000 }),
        ),
      );
      const accepted = results.filter((r) => r.status === 202);
      expect(accepted.length).toBeGreaterThanOrEqual(1);
      expect(new Set(accepted.map((r) => r.body.orderId)).size).toBe(1);
      for (const r of results.filter((r) => r.status !== 202)) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('idempotency_in_flight');
      }
      expect(await orderCount(user)).toBe(1);
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 8 });
    });

    it('S10 AS-18: a key reused with another body or no body is 422 idempotency_key_reuse; a missing or malformed key is 422', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const key = newKey();
      expect(
        (await checkout(user, key, { expectedTotalMinor: 1_000 })).status,
      ).toBe(202);
      for (const body of [{ expectedTotalMinor: 3_000 }, undefined]) {
        const res = await checkout(user, key, body);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('idempotency_key_reuse');
      }
      expect(await orderCount(user)).toBe(1);

      const missing = await t.as(user).post('/api/checkout').send({});
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      for (const bad of ['short', 'x'.repeat(129), 'has a space 1234']) {
        const res = await t
          .as(user)
          .post('/api/checkout')
          .set('Idempotency-Key', bad)
          .send({});
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('idempotency_key_invalid');
      }
    });

    it('S10 AS-18: an absent body and an empty object are the same request for a key (the fingerprint treats them alike)', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const key = newKey();
      const first = await checkout(user, key);
      expect(first.status).toBe(202);
      await addToCart(user, a, 1);
      const again = await checkout(user, key, {});
      expect(again.status).toBe(202);
      expect(again.body.orderId).toBe(first.body.orderId);
      expect(again.headers['idempotency-replayed']).toBe('true');
    });

    it('S10 AS-19: keys are per buyer: another buyer using the same key gets their own order', async () => {
      const { a } = await standard();
      const [u, v] = [await t.newUser(), await t.newUser()];
      await addToCart(u, a, 1);
      await addToCart(v, a, 2);
      const key = newKey();
      const first = await checkout(u, key, {});
      const second = await checkout(v, key, {});
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(second.body.orderId).not.toBe(first.body.orderId);
      expect(second.body.totalMinor).toBe(2_000);
      expect(second.headers['idempotency-replayed']).toBeUndefined();
    });

    it('S10 AS-20: a failure before any order exists releases the key; an out_of_stock after the order exists is final for that key, a new key tries again', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      const key = newKey();
      const empty = await checkout(user, key, {});
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('cart_empty');
      await addToCart(user, a, 1);
      const fixed = await checkout(user, key, {});
      expect(fixed.status).toBe(202);

      const scarce = await seedShopWithProducts(t.app, [
        { priceMinor: 700, quantity: 1, currency: 'EUR' },
      ]);
      const buyer = await t.newUser();
      await addToCart(buyer, scarce.products[0], 2);
      const stockKey = newKey();
      const refused = await checkout(buyer, stockKey, {});
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'out_of_stock',
        productIds: [scarce.products[0].id],
      });
      const replayed = await checkout(buyer, stockKey, {});
      expect(replayed.status).toBe(422);
      expect(replayed.body.code).toBe('out_of_stock');
      expect(replayed.headers['idempotency-replayed']).toBe('true');
      expect(await orderCount(buyer)).toBe(1);

      await exec(
        t.app,
        `UPDATE "Product" SET "quantity" = 5 WHERE "id" = :id`,
        { id: scarce.products[0].id },
      );
      const another = await checkout(buyer, newKey(), {});
      expect(another.status).toBe(202);
      expect(await orderCount(buyer)).toBe(2);
    });
  });

  describe('access, validation and the split (AS-21 to AS-24)', () => {
    it('S10 AS-21: 401 without a session (guest cookie alone is not one); cart_empty; product_unavailable lists every bad product; mixed_currency; nothing is created', async () => {
      const { a } = await standard();
      expect(
        (
          await t
            .http()
            .post('/api/checkout')
            .set('Idempotency-Key', newKey())
            .send({})
        ).status,
      ).toBe(401);
      const guest = await t
        .http()
        .put(`/api/cart/items/${a.id}`)
        .send({ quantity: 1 });
      const cookie = (
        guest.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      expect(
        (
          await t
            .http()
            .post('/api/checkout')
            .set('Cookie', [cookie])
            .set('Idempotency-Key', newKey())
            .send({})
        ).status,
      ).toBe(401);

      const user = await t.newUser();
      expect((await checkout(user, newKey(), {})).body.code).toBe('cart_empty');

      const archived = await seedShopWithProducts(t.app, [
        { status: 'ARCHIVED', currency: 'EUR' },
      ]);
      const sandbox = await seedShopWithProducts(t.app, [
        { isSandbox: true, currency: 'EUR' },
      ]);
      const suspended = await seedShopWithProducts(
        t.app,
        [{ currency: 'EUR' }],
        { status: 'SUSPENDED' },
      );
      const sandboxShop = await seedShopWithProducts(
        t.app,
        [{ currency: 'EUR' }],
        { sandboxOf: a.shopId },
      );
      const missing = { id: randomUUID() };
      const bad = [
        archived.products[0],
        sandbox.products[0],
        suspended.products[0],
        sandboxShop.products[0],
        missing,
      ];
      await addToCart(user, a, 1);
      for (const p of bad) await addToCart(user, p, 1);
      const res = await checkout(user, newKey(), {});
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('product_unavailable');
      expect([...res.body.productIds].sort()).toEqual(
        bad.map((p) => p.id).sort(),
      );

      const mixed = await t.newUser();
      const usd = await seedShopWithProducts(t.app, [{ currency: 'USD' }]);
      await addToCart(mixed, a, 1);
      await addToCart(mixed, usd.products[0], 1);
      const mixedRes = await checkout(mixed, newKey(), {});
      expect(mixedRes.status).toBe(422);
      expect(mixedRes.body.code).toBe('mixed_currency');

      expect(await orderCount(user)).toBe(0);
      expect(await orderCount(mixed)).toBe(0);
      expect((await stockOf(t.app, [a.id]))[a.id]).toBe(10);
      expect(await cartOf(user)).toHaveProperty(a.id, 1);
    });

    it('S10 AS-22: five lines of three shops give one order and three shop orders whose subtotals add up; a product without a shop is product_unavailable', async () => {
      const s1 = await seedShopWithProducts(t.app, [
        { priceMinor: 300, currency: 'EUR' },
        { priceMinor: 450, currency: 'EUR' },
      ]);
      const s2 = await seedShopWithProducts(t.app, [
        { priceMinor: 120, currency: 'EUR' },
        { priceMinor: 80, currency: 'EUR' },
      ]);
      const s3 = await seedShopWithProducts(t.app, [
        { priceMinor: 999, currency: 'EUR' },
      ]);
      const user = await t.newUser();
      const lines: Array<[{ id: string }, number]> = [
        [s1.products[0], 2],
        [s1.products[1], 1],
        [s2.products[0], 3],
        [s2.products[1], 1],
        [s3.products[0], 2],
      ];
      for (const [p, q] of lines) await addToCart(user, p, q);
      const res = await checkout(user, newKey(), {});
      expect(res.status).toBe(202);
      const id = res.body.orderId;
      const shopOrders = await rows<{ shopId: string; subtotal: string }>(
        t.app,
        `SELECT "shopId", "subtotal" FROM "ShopOrder" WHERE "bisOrderId" = :id`,
        { id },
      );
      expect(shopOrders).toHaveLength(3);
      const expected: Record<string, number> = {
        [s1.shop.id]: 300 * 2 + 450,
        [s2.shop.id]: 120 * 3 + 80,
        [s3.shop.id]: 999 * 2,
      };
      for (const so of shopOrders)
        expect(Number(so.subtotal)).toBe(expected[so.shopId]);
      expect(shopOrders.reduce((s, so) => s + Number(so.subtotal), 0)).toBe(
        res.body.totalMinor,
      );
      const items = await rows<{ shopId: string | null }>(
        t.app,
        `SELECT "shopId" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
        { id },
      );
      expect(items).toHaveLength(5);
      expect(items.every((i) => i.shopId !== null)).toBe(true);

      const shopless = await seedShopWithProducts(t.app, [{ currency: 'EUR' }]);
      await exec(
        t.app,
        `UPDATE "Product" SET "shopId" = NULL WHERE "id" = :id`,
        { id: shopless.products[0].id },
      );
      const other = await t.newUser();
      await addToCart(other, shopless.products[0], 1);
      const refused = await checkout(other, newKey(), {});
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'product_unavailable',
        productIds: [shopless.products[0].id],
      });
    });

    it('S10 AS-24: a shop discount is allocated over that shop’s lines; a failing or invalid source falls back to catalogue prices with the metric and a warning that carries no payload', async () => {
      const s1 = await seedShopWithProducts(t.app, [
        { priceMinor: 1_000, quantity: 100, currency: 'EUR' },
        { priceMinor: 500, quantity: 100, currency: 'EUR' },
      ]);
      const s2 = await seedShopWithProducts(t.app, [
        { priceMinor: 700, quantity: 100, currency: 'EUR' },
      ]);
      const [p1, p2] = s1.products;
      const [p3] = s2.products;
      const fresh = async () => {
        const u = await t.newUser();
        await addToCart(u, p1, 1);
        await addToCart(u, p2, 2); // S1 gross 2000
        await addToCart(u, p3, 1);
        return u;
      };

      t.discounts.impl = async () => [
        { shopId: s1.shop.id, discountMinor: 300 },
      ];
      const buyer = await fresh();
      const ok = await checkout(buyer, newKey(), {});
      expect(ok.status).toBe(202);
      expect(ok.body.totalMinor).toBe(2_700 - 300);
      const items = await rows<{
        title: string;
        discountMinor: string;
        lineTotalMinor: string;
      }>(
        t.app,
        `SELECT "discountMinor", "lineTotalMinor", "shopId" FROM "BisOrderItem" WHERE "bisOrderId" = :id ORDER BY "priceAtPurchase" DESC`,
        { id: ok.body.orderId },
      );
      // by unit price: 1000 (S1), 700 (S2), 500 (S1, x2); the 300 of S1 splits by line gross 1000 : 1000
      expect(items.map((i) => Number(i.discountMinor))).toEqual([150, 0, 150]);
      const so = await rows<{ shopId: string; subtotal: string }>(
        t.app,
        `SELECT "shopId", "subtotal" FROM "ShopOrder" WHERE "bisOrderId" = :id`,
        { id: ok.body.orderId },
      );
      expect(
        Object.fromEntries(so.map((s) => [s.shopId, Number(s.subtotal)])),
      ).toEqual({ [s1.shop.id]: 1_700, [s2.shop.id]: 700 });

      const warn = jest.spyOn(Logger.prototype, 'warn');
      const fallbacks = (reason: string) =>
        MetricsRegistry.value('orders_discount_fallback_total', { reason }) ??
        0;
      const cases: Array<[string, string, () => Promise<unknown>]> = [
        ['timeout', 'timeout', () => new Promise(() => undefined)],
        [
          'error',
          'error',
          () => Promise.reject(new Error('source down secret-payload-123')),
        ],
        [
          'invalid',
          'negative',
          async () => [{ shopId: s1.shop.id, discountMinor: -5 }],
        ],
        [
          'invalid',
          'fraction',
          async () => [{ shopId: s1.shop.id, discountMinor: 10.5 }],
        ],
        [
          'invalid',
          'over gross',
          async () => [{ shopId: s1.shop.id, discountMinor: 2_001 }],
        ],
        [
          'invalid',
          'unknown shop',
          async () => [{ shopId: randomUUID(), discountMinor: 5 }],
        ],
      ];
      for (const [reason, label, impl] of cases) {
        t.discounts.impl = impl;
        const before = fallbacks(reason);
        const u = await fresh();
        const res = await checkout(u, newKey(), {});
        expect([label, res.status]).toEqual([label, 202]);
        expect([label, res.body.totalMinor]).toEqual([label, 2_700]);
        expect([label, fallbacks(reason)]).toEqual([label, before + 1]);
      }
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'secret-payload-123',
      );
      warn.mockRestore();
    });
  });

  describe('limits, locking and the cart (AS-26 to AS-29)', () => {
    it('S10 AS-26: the 11th checkout request in a minute is 429 with Retry-After and creates no order', async () => {
      const user = await t.newUser();
      for (let i = 0; i < 10; i++)
        expect((await checkout(user, newKey(), {})).status).toBe(422);
      const limited = await checkout(user, newKey(), {});
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body.code).toBe('rate_limited');
      expect(await orderCount(user)).toBe(0);
    });

    it('S10 AS-27: two checkouts with different keys at once give one 202 and one 409 checkout_in_progress (or 422 cart_empty if it ran after); one order', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const gate = createGate();
      t.patch(
        t.app.get(ProductStockService),
        'applyStockDelta',
        (original) =>
          (async (ops: never) => {
            await gate.wait();
            return original(ops);
          }) as never,
      );
      const first = checkout(user, newKey(), {}).then((r) => r); // supertest sends on `then`
      await gate.reached;
      const second = await checkout(user, newKey(), {});
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('checkout_in_progress');
      gate.open();
      expect((await first).status).toBe(202);
      expect(await orderCount(user)).toBe(1);
      const later = await checkout(user, newKey(), {});
      expect([later.status, later.body.code]).toEqual([422, 'cart_empty']);
    });

    it('S10 AS-28: the cart keeps what changed after checkout read it: order A×2, cart {A:3, C:1}', async () => {
      const { a, b } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 2);
      const store = t.app.get<CartStore>(CART_STORE);
      const gate = createGate();
      let armed = true;
      t.patch(
        store,
        'list',
        (original) =>
          (async (cartId: string, now: Date) => {
            const result = await original(cartId, now);
            if (armed) {
              armed = false;
              await gate.wait();
            }
            return result;
          }) as never,
      );
      const running = checkout(user, newKey(), {}).then((r) => r); // supertest sends on `then`
      await gate.reached;
      await addToCart(user, a, 3);
      await addToCart(user, b, 1);
      gate.open();
      const res = await running;
      expect(res.status).toBe(202);
      const items = await rows<{ productId: string; quantity: number }>(
        t.app,
        `SELECT "productId", "quantity" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
        { id: res.body.orderId },
      );
      expect(items).toEqual([{ productId: a.id, quantity: 2 }]);
      expect(await cartOf(user)).toEqual({ [a.id]: 3, [b.id]: 1 });
    });

    it('S10 AS-29: a refused cart cleanup still gives 202; the clean-up job removes the lines; a failing job is counted', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 2);
      const store = t.app.get<CartStore>(CART_STORE);
      const restore = t.patch(
        store,
        'removeConsumed',
        () =>
          (async () => {
            throw new Error('store refused');
          }) as never,
      );
      const res = await checkout(user, newKey(), {});
      expect(res.status).toBe(202);
      expect(await cartOf(user)).toEqual({ [a.id]: 2 });

      const queued = await probe.find('orders.clear-cart');
      expect(queued).toHaveLength(1);
      const jobs = t.app.get(OrderJobs);
      const failed = () =>
        MetricsRegistry.value('orders_cart_cleanup_failed_total') ?? 0;
      const before = failed();
      await expect(
        jobs.clearCart(queued[0].payload as never),
      ).rejects.toThrow();
      expect(failed()).toBe(before + 1);
      restore();
      await jobs.clearCart(queued[0].payload as never);
      expect(await cartOf(user)).toEqual({});
    });
  });

  describe('time budgets (AS-30)', () => {
    it('S10 AS-30: a slow product read is 503 checkout_unavailable (Retry-After 2) with no order and the key unused', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const config = t.app.get(ApiConfigService);
      t.patch(
        config,
        'get',
        (original) =>
          ((key: string) =>
            key === 'orders_catalog_timeout_ms'
              ? 100
              : original(key as never)) as never,
      );
      const restore = t.patch(
        t.app.get(ProductQueryService),
        'getProductsByIds',
        (original) =>
          (async (...args: never[]) => {
            await new Promise((r) => setTimeout(r, 400));
            return Reflect.apply(original as never, undefined, args);
          }) as never,
      );
      const key = newKey();
      const slow = await checkout(user, key, {});
      expect(slow.status).toBe(503);
      expect(slow.body.code).toBe('checkout_unavailable');
      expect(slow.headers['retry-after']).toBe('2');
      expect(await orderCount(user)).toBe(0);
      restore();
      expect((await checkout(user, key, {})).status).toBe(202);
    });

    it('S10 AS-30: a slow stock call is 503, leaves the order PENDING and the same key 409 in flight until recovery resolves it; then the retry gets the resolved outcome', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const config = t.app.get(ApiConfigService);
      t.patch(
        config,
        'get',
        (original) =>
          ((key: string) =>
            key === 'orders_stock_timeout_ms'
              ? 100
              : original(key as never)) as never,
      );
      const restore = t.patch(
        t.app.get(ProductStockService),
        'applyStockDelta',
        (original) =>
          (async (...args: never[]) => {
            await new Promise((r) => setTimeout(r, 400));
            return Reflect.apply(original as never, undefined, args);
          }) as never,
      );
      const key = newKey();
      const slow = await checkout(user, key, {});
      expect(slow.status).toBe(503);
      expect(slow.body.code).toBe('checkout_unavailable');
      const [order] = await ordersOf(t.app, user.id);
      expect(order.status).toBe('PENDING');

      const pending = await checkout(user, key, {});
      expect(pending.status).toBe(409);
      expect(pending.body.code).toBe('idempotency_in_flight');

      restore();
      t.clock.set(new Date(t.clock.now().getTime() + 61_000));
      await t.app.get(OrderJobs).recoverPending();
      expect((await orderRow(t.app, order.id)).status).toBe('RESERVED');
      const resolved = await checkout(user, key, {});
      expect(resolved.status).toBe(202);
      expect(resolved.body.orderId).toBe(order.id);
      expect(await orderCount(user)).toBe(1);
      expect(await stockOf(t.app, [a.id])).toEqual({ [a.id]: 9 });
      expect(await reservationsOf(t.app, order.id)).toHaveLength(1);
    });

    it('S10 AS-30: the whole request stops at the checkout budget', async () => {
      const { a } = await standard();
      const user = await t.newUser();
      await addToCart(user, a, 1);
      const config = t.app.get(ApiConfigService);
      t.patch(
        config,
        'get',
        (original) =>
          ((key: string) =>
            key === 'orders_checkout_budget_ms'
              ? 150
              : original(key as never)) as never,
      );
      t.patch(
        t.app.get(ProductQueryService),
        'getProductsByIds',
        (original) =>
          (async (...args: never[]) => {
            await new Promise((r) => setTimeout(r, 600));
            return Reflect.apply(original as never, undefined, args);
          }) as never,
      );
      const started = Date.now();
      const res = await checkout(user, newKey(), {});
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('checkout_unavailable');
      expect(Date.now() - started).toBeLessThan(550);
    });
  });
});

describe('Checkout: fail-closed rate limiting (AS-26)', () => {
  it('S10 AS-26: with the limiter store down the checkout is refused and no order exists', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const t = await createOrdersApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await t.reset();
      const user = await t.newUser();
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const res = await t
        .as(user)
        .post('/api/checkout')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({});
      // refused with 503 by whichever fail-closed guard meets the dead store first (the sensitive-session check or the limiter)
      expect(res.status).toBe(503);
      expect(['rate_limiter_unavailable', 'overloaded']).toContain(
        res.body.code,
      );
      // the limiter itself, asked directly, fails closed for the checkout policy
      expect(
        await t.app
          .get(RateLimiterService)
          .check('checkout.create', `user:${user.id}`),
      ).toMatchObject({ allowed: false });
      proxy.mode = 'pass';
      expect(
        await rows(t.app, `SELECT 1 FROM "BisOrder" WHERE "userId" = :id`, {
          id: user.id,
        }),
      ).toEqual([]);
    } finally {
      proxy.mode = 'pass';
      await t.close();
      await proxy.close();
    }
  });
});
