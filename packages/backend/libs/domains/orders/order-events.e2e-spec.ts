import { createHmac, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { OrderFulfilmentService } from './application/order-fulfilment.service';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import type { ProcessWebhookPayload } from './application/order.job-types';
import { OrderJobs } from './infra/order.jobs';
import {
  KIT_WEBHOOK_SECRET,
  createOrdersApp,
  exec,
  historyOf,
  orderRow,
  reservationsOf,
  rows,
  seedPendingOrder,
  seedShopWithProducts,
  type OrdersTestApp,
} from './testing/orders-app';

const MIN = 60_000;
const DAY = 86_400_000;

describe('Orders: events, realtime, observability and jobs', () => {
  let t: OrdersTestApp;
  let lifecycle: OrderLifecycleService;
  let jobs: OrderJobs;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createOrdersApp();
    lifecycle = t.app.get(OrderLifecycleService);
    jobs = t.app.get(OrderJobs);
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const hold = () => new Date(t.clock.now().getTime() + 15 * MIN);
  const pending = async (quantity = 2) => {
    const buyer = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 1_000, quantity: 10 },
    ]);
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [
        {
          productId: products[0].id,
          shopId: shop.id,
          quantity,
          unitPriceMinor: 1_000,
        },
      ],
    });
    return { buyer, shop, product: products[0], order };
  };
  const move = (orderId: string, command: object) =>
    lifecycle.transition(orderId, command as never, {
      actor: 'system:test',
      reservedUntil: hold(),
    });
  const reserved = async () => {
    const seeded = await pending();
    await move(seeded.order.id, { type: 'reserve' });
    return seeded;
  };
  const events = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId)).filter((r) => r.kind === 'event');

  describe('events (AS-64)', () => {
    it('S10 AS-64: every transition writes one envelope with a strictly rising orderVersion, parsed by orderEventSchemas', async () => {
      const { buyer, order } = await pending();
      const fulfilment = t.app.get(OrderFulfilmentService);
      await move(order.id, { type: 'reserve' });
      await move(order.id, { type: 'markPaid', paymentRef: 'pi_64' });
      await fulfilment.apply(order.id, { type: 'startFulfilment' });
      await move(order.id, { type: 'ship', trackingCode: 'TRK' });
      await move(order.id, { type: 'deliver' });
      const second = await reserved();
      await move(second.order.id, { type: 'cancel', reason: 'user_cancelled' });
      const third = await reserved();
      await move(third.order.id, { type: 'markPaid', paymentRef: 'pi_64b' });
      await move(third.order.id, { type: 'refund', reason: 'full_refund' });

      const types = new Set<string>();
      for (const orderId of [order.id, second.order.id, third.order.id]) {
        let last = 0;
        const list = await events(orderId);
        expect(list.length).toBeGreaterThan(0);
        for (const row of list) {
          const envelope = row.payload as {
            eventId: string;
            type: keyof typeof orderEventSchemas;
            version: number;
            occurredAt: string;
            aggregateId: string;
            aggregateVersion: number;
            payload: unknown;
          };
          expect(row.topic).toBe('orders.events');
          expect(envelope.version).toBe(1);
          expect(envelope.aggregateId).toBe(orderId);
          expect(Number.isNaN(Date.parse(envelope.occurredAt))).toBe(false);
          expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
          const parsed = orderEventSchemas[envelope.type].parse(
            envelope.payload,
          ) as { orderVersion: number };
          expect(parsed.orderVersion).toBeGreaterThan(last);
          expect(parsed.orderVersion).toBe(envelope.aggregateVersion);
          last = parsed.orderVersion;
          types.add(envelope.type);
        }
        // exactly one event per applied move after creation
        expect(list).toHaveLength((await historyOf(t.app, orderId)).length - 1);
      }
      expect([...types].sort()).toEqual([
        'order.cancelled',
        'order.fulfilment_changed',
        'order.paid',
        'order.refunded',
        'order.reserved',
      ]);
      expect(buyer.id).toBeDefined();
    });

    it('S10 AS-64: order.paid lines carry the stable line id and the category kept at purchase (S16 D1)', async () => {
      const buyer = await t.newUser();
      const { shop, products } = await seedShopWithProducts(t.app, [
        { priceMinor: 1_000, quantity: 10 },
        { priceMinor: 500, quantity: 10 },
      ]);
      const order = await seedPendingOrder(t.app, {
        userId: buyer.id,
        lines: [
          {
            productId: products[0].id,
            shopId: shop.id,
            quantity: 1,
            unitPriceMinor: 1_000,
            category: 'electronics',
          },
          {
            productId: products[1].id,
            shopId: shop.id,
            quantity: 2,
            unitPriceMinor: 500,
            category: 'books',
          },
        ],
      });
      await move(order.id, { type: 'reserve' });
      await move(order.id, { type: 'markPaid', paymentRef: 'pi_line' });

      const items = await rows<{
        id: string;
        productId: string;
        category: string;
      }>(
        t.app,
        `SELECT "id", "productId", "category" FROM "BisOrderItem" WHERE "bisOrderId" = :orderId`,
        { orderId: order.id },
      );
      const paid = (await events(order.id)).find(
        (r) => r.type === 'order.paid',
      );
      const payload = orderEventSchemas['order.paid'].parse(
        (paid!.payload as { payload: unknown }).payload,
      );
      expect(payload.lines).toHaveLength(2);
      for (const line of payload.lines) {
        const item = items.find((i) => i.productId === line.productId)!;
        expect(line.lineId).toBe(item.id);
        expect(line.category).toBe(item.category);
      }
      expect(payload.lines.map((l) => l.category).sort()).toEqual([
        'books',
        'electronics',
      ]);
      expect(new Set(payload.lines.map((l) => l.lineId)).size).toBe(2);
    });

    it('S10 AS-64: when the outbox write fails the whole transition rolls back and the caller gets a retryable 503', async () => {
      const { buyer, order } = await reserved();
      const before = await orderRow(t.app, order.id);
      const history = (await historyOf(t.app, order.id)).length;
      const eventCount = (await events(order.id)).length;
      const reservations = await reservationsOf(t.app, order.id);
      t.patch(
        t.app.get(OutboxService),
        'append',
        () => (() => Promise.reject(new Error('outbox is down'))) as never,
      );

      const res = await t.as(buyer).post(`/api/orders/${order.id}/cancel`);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(await orderRow(t.app, order.id)).toEqual(before);
      expect(await historyOf(t.app, order.id)).toHaveLength(history);
      expect(await events(order.id)).toHaveLength(eventCount);
      expect(await reservationsOf(t.app, order.id)).toEqual(reservations);
    });
  });

  describe('realtime (AS-65)', () => {
    it('S10 AS-65: with the hub down the order is paid, its events commit, the failure is counted and GET shows the new status', async () => {
      const { buyer, order } = await reserved();
      t.realtime.published.length = 0;
      t.realtime.down = true;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const failed = () =>
        MetricsRegistry.value('orders_realtime_failed_total') ?? 0;
      const before = failed();

      const result = await move(order.id, {
        type: 'markPaid',
        paymentRef: 'pi_65',
      });
      expect(result.kind).toBe('applied');
      expect(failed()).toBe(before + 1);
      expect(warn).toHaveBeenCalled();
      expect((await events(order.id)).map((e) => e.type)).toEqual([
        'order.reserved',
        'order.paid',
      ]);
      const res = await t.as(buyer).get(`/api/orders/${order.id}`);
      expect(res.body.status).toBe('PAID');
      expect(t.realtime.published).toHaveLength(0);
    });
  });

  describe('observability (AS-66)', () => {
    it('S10 AS-66: logs carry the order id and never the body, signature, secret, cookie, authorization or key; the metrics exist', async () => {
      const lines: string[] = [];
      const capture = (...args: unknown[]) => {
        lines.push(
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
      };
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest.spyOn(Logger.prototype, level).mockImplementation(capture);

      const { products } = await seedShopWithProducts(t.app, [
        { title: 'Gadget', priceMinor: 2_500, quantity: 10, currency: 'EUR' },
      ]);
      const user = await t.newUser();
      await t
        .as(user)
        .put(`/api/cart/items/${products[0].id}`)
        .send({ quantity: 1 })
        .expect(200);
      const key = `key-secret-${randomUUID()}`;
      t.discounts.impl = () => Promise.reject(new Error('discounts are down'));
      const checkout = await t
        .as(user)
        .post('/api/checkout')
        .set('Idempotency-Key', key)
        .send({});
      expect(checkout.status).toBe(202);
      const orderId = checkout.body.orderId as string;

      const bodyMarker = `marker-${randomUUID()}`;
      const raw = JSON.stringify({
        id: 'evt_66',
        type: 'payment_intent.succeeded',
        data: {
          object: { id: 'pi_66', metadata: { orderId }, note: bodyMarker },
        },
      });
      const ts = Math.floor(t.clock.now().getTime() / 1000);
      const signature = `t=${ts},v1=${createHmac('sha256', KIT_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex')}`;
      const forged = `t=${ts},v1=${'0'.repeat(64)}`;
      await t
        .http()
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', forged)
        .send(raw)
        .expect(400);
      await t
        .http()
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(raw)
        .expect(200);

      // an expiry, so the hold-expired counter moves
      t.clock.advance(16 * MIN);
      await jobs.expireReservation({ orderId });

      const text = lines.join('\n');
      expect(text).toContain(orderId);
      for (const forbidden of [
        key,
        signature,
        forged,
        bodyMarker,
        KIT_WEBHOOK_SECRET,
        user.bearer,
        'authorization',
        'set-cookie',
      ])
        expect(text).not.toContain(forbidden);

      for (const [name, labels] of [
        ['orders_checkout_total', { outcome: 'reserved' }],
        ['orders_reservation_expired_total', {}],
        ['orders_webhook_events_total', { result: 'invalid_signature' }],
        ['orders_webhook_events_total', { result: 'received' }],
        ['orders_discount_fallback_total', { reason: 'error' }],
      ] as const)
        expect(MetricsRegistry.value(name, labels)).toBeGreaterThanOrEqual(1);
      for (const name of [
        'orders_checkout_total',
        'orders_reservation_expired_total',
        'orders_webhook_events_total',
        'orders_discount_fallback_total',
      ])
        for (const set of MetricsRegistry.labelSets(name))
          expect(Object.keys(set).every((k) => k !== 'orderId')).toBe(true);
    });
  });

  describe('jobs (AS-67)', () => {
    it('S10 AS-67: expiry and sweeper run twice and on two instances at once with one effect', async () => {
      const a = await reserved();
      const b = await reserved();
      t.clock.advance(16 * MIN);
      await Promise.all([
        jobs.expireReservation({ orderId: a.order.id }),
        jobs.expireReservation({ orderId: a.order.id }),
      ]);
      await Promise.all([jobs.sweepExpired(), jobs.sweepExpired()]);
      await jobs.sweepExpired();
      for (const { order } of [a, b]) {
        expect((await orderRow(t.app, order.id)).status).toBe('CANCELLED');
        expect(
          (await events(order.id)).filter((e) => e.type === 'order.cancelled'),
        ).toHaveLength(1);
      }
    });

    it('S10 AS-67: processing one stored webhook event twice at once pays the order once', async () => {
      const { order } = await reserved();
      const eventId = 'evt_67';
      t.payments.statuses.set('pi_67', {
        status: 'COMPLETED',
        amountMinor: 2_000,
        currency: 'USD',
      });
      const raw = JSON.stringify({
        id: eventId,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_67',
            amount: 2_000,
            amount_received: 2_000,
            currency: 'usd',
            metadata: { orderId: order.id },
          },
        },
      });
      const ts = Math.floor(t.clock.now().getTime() / 1000);
      await t
        .http()
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set(
          'Stripe-Signature',
          `t=${ts},v1=${createHmac('sha256', KIT_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex')}`,
        )
        .send(raw)
        .expect(200);
      const [queued] = await probe.find('orders.process-webhook', { eventId });
      const ctx = {
        jobId: 'test',
        attempt: 1,
        maxAttempts: 8,
        isLastAttempt: false,
        heartbeat: async () => undefined,
        signal: new AbortController().signal,
      };
      const payload = queued.payload as ProcessWebhookPayload;
      await Promise.all([
        jobs.processWebhook(payload, ctx),
        jobs.processWebhook(payload, ctx),
      ]);
      expect((await orderRow(t.app, order.id)).status).toBe('PAID');
      expect(
        (await events(order.id)).filter((e) => e.type === 'order.paid'),
      ).toHaveLength(1);
    });

    it('S10 AS-67: the inbox purge removes stripe events older than 35 days and keeps the rest', async () => {
      const now = t.clock.now();
      const insert = (provider: string, eventId: string, ageMs: number) =>
        exec(
          t.app,
          `INSERT INTO "ProcessedWebhookEvent" ("provider", "eventId", "status", "attempts", "claimedAt", "handledAt", "createdAt", "processedAt")
           VALUES (:provider, :eventId, 'PROCESSED', 1, :at, :at, :at, :at)`,
          { provider, eventId, at: new Date(now.getTime() - ageMs) },
        );
      await insert('stripe', 'old', 35 * DAY + 1_000);
      await insert('stripe', 'edge', 35 * DAY);
      await insert('stripe', 'young', DAY);
      await insert('spec-other', 'old-other', 40 * DAY);
      await Promise.all([jobs.purgeWebhookInbox(), jobs.purgeWebhookInbox()]);
      const left = await rows<{ provider: string; eventId: string }>(
        t.app,
        `SELECT "provider", "eventId" FROM "ProcessedWebhookEvent" WHERE "eventId" IN ('old','edge','young','old-other') ORDER BY "eventId"`,
      );
      expect(left.map((r) => r.eventId)).toEqual([
        'edge',
        'old-other',
        'young',
      ]);
      await exec(
        t.app,
        `DELETE FROM "ProcessedWebhookEvent" WHERE "provider" = 'spec-other'`,
      );
    });

    it('S10 AS-67: the title backfill fills titles and line totals in batches, uses "(removed product)" for gone products, and is safe to repeat', async () => {
      const { order, product } = await pending(3);
      const ghost = randomUUID();
      await exec(
        t.app,
        `UPDATE "BisOrderItem" SET "title" = NULL, "lineTotalMinor" = NULL WHERE "bisOrderId" = :id`,
        { id: order.id },
      );
      await exec(
        t.app,
        `INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "shopId", "quantity", "priceAtPurchase", "discountMinor", "title", "lineTotalMinor", "createdAt", "updatedAt")
         SELECT uuidv7(), "bisOrderId", :ghost, "shopId", 2, 700, 0, NULL, NULL, "createdAt", "updatedAt" FROM "BisOrderItem" WHERE "bisOrderId" = :id LIMIT 1`,
        { id: order.id, ghost },
      );
      await Promise.all([jobs.backfillItemTitles(), jobs.backfillItemTitles()]);
      await jobs.backfillItemTitles();
      const items = await rows<{
        productId: string;
        title: string;
        lineTotalMinor: string;
      }>(
        t.app,
        `SELECT "productId", "title", "lineTotalMinor" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
        { id: order.id },
      );
      const real = items.find((i) => i.productId === product.id)!;
      const gone = items.find((i) => i.productId === ghost)!;
      expect(real.title).not.toBeNull();
      expect(real.title).not.toBe('(removed product)');
      expect(Number(real.lineTotalMinor)).toBe(3_000);
      expect(gone.title).toBe('(removed product)');
      expect(Number(gone.lineTotalMinor)).toBe(1_400);
      expect(MetricsRegistry.value('orders_backfill_orphans')).toBe(0);
    });
  });
});
