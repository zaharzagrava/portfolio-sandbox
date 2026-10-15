import { v7 as uuidv7 } from 'uuid';
import {
  createdWebhookEndpointSchema,
  webhookMessageSchema,
  type WebhookMessage,
} from '@marketplace-sandbox/contracts';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { parseEnvelope } from '@app/infrastructure/projections/envelope-parser';
import { WebhookDeliveryService } from './application/webhook-delivery.service';
import { WEBHOOK_QUEUE } from './domain/webhook-events';
import {
  DeliveryLog,
  EndpointRepository,
  type DeliveryMessage,
  type DeliveryRecord,
} from './domain/webhook-ports';
import {
  WebhookOrdersConsumer,
  WebhookPayoutsConsumer,
  WebhookProductsConsumer,
  WebhookShopDeletedConsumer,
} from './infra/webhook-consumers';
import {
  createWebhookKit,
  envelope,
  FROZEN_NOW,
  orderPaidEvent,
  orderStatusEvent,
  payoutEvent,
  productEvent,
  shopDeletedEvent,
  type SourceEvent,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import { createLane, feed } from './testing/webhook-lane';
import { clearRateLimits } from './testing/public-api-kit';
import { WebhooksProjectorModule } from './webhooks-projector.module';
import { WebhooksWorkerModule } from './webhooks-worker.module';

const ORDERS = 'webhook-router-orders';

describe('Webhooks: routing of domain events (consumers)', () => {
  let queue: InMemoryTaskQueue;
  let t: WebhookKit;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    t = await createWebhookKit({
      extraImports: [WebhooksProjectorModule, WebhooksWorkerModule],
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
  }, 120_000);
  let second: WebhookKit | undefined;
  afterAll(async () => {
    await t.close();
    await second?.close().catch(() => undefined); // its resources are shared with the first instance and already closed
  });
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    queue.sent.length = 0;
  });

  const orders = () => t.app.get(WebhookOrdersConsumer);
  const products = () => t.app.get(WebhookProductsConsumer);
  const payouts = () => t.app.get(WebhookPayoutsConsumer);
  const shopDeleted = () => t.app.get(WebhookShopDeletedConsumer);
  const log = () => t.app.get(DeliveryLog, { strict: false });
  const lane = () => createLane(t, queue);

  const endpoint = async (
    world: WebhookWorld,
    events: string[],
    extra: Record<string, unknown> = {},
  ) => {
    const res = await t
      .as(world.owner)
      .post(t.base(world))
      .send({ url: t.endpointUrl(), events, ...extra });
    if (res.status !== 201)
      throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return createdWebhookEndpointSchema.parse(res.body);
  };
  /** The queued deliveries of one endpoint as (message, stored record, parsed body). */
  const deliveriesOf = async (endpointId: string) => {
    const out: {
      message: DeliveryMessage;
      record: DeliveryRecord;
      body: WebhookMessage;
    }[] = [];
    for (const message of lane().pending(endpointId)) {
      const record = await log().getDelivery(
        endpointId,
        message.eventId,
        t.clock.now(),
      );
      out.push({
        message,
        record: record!,
        body: webhookMessageSchema.parse(JSON.parse(record!.body)),
      });
    }
    return out;
  };
  const receipts = (group: string, eventId: string) =>
    t.rows<{ status: string }>(
      `SELECT status FROM "ProcessedWebhookEvent" WHERE provider = :group AND "eventId" = :eventId`,
      { group, eventId },
    );
  const allPending = () => lane().pending();

  describe('orders (AS-23, AS-24, AS-25, AS-26)', () => {
    it('S43 AS-23: a multi-shop paid order gives each shop its own slice: its lines and subtotal only, integer minor units, nothing of the other shop or the buyer', async () => {
      const wa = await t.seedWorld();
      const wb = await t.seedWorld();
      const ea = await endpoint(wa, ['order.paid']);
      const eb = await endpoint(wb, ['order.paid']);
      const [pa1, pa2, pb1] = [uuidv7(), uuidv7(), uuidv7()];
      const buyer = uuidv7();
      const event = orderPaidEvent({
        userId: buyer,
        orderVersion: 4,
        shops: [
          {
            shopId: wa.shop.id,
            lines: [
              { productId: pa1, title: 'Alpha one', unitPriceMinor: 2000 },
              {
                productId: pa2,
                title: 'Alpha two',
                quantity: 2,
                unitPriceMinor: 1500,
              },
            ],
          },
          {
            shopId: wb.shop.id,
            lines: [
              { productId: pb1, title: 'Beta one', unitPriceMinor: 3000 },
            ],
          },
        ],
      });

      expect(await feed(orders(), [event])).toEqual([]);

      const a = await deliveriesOf(ea.id);
      const b = await deliveriesOf(eb.id);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      const shopOrders = event.payload.shopOrders as {
        shopOrderId: string;
        shopId: string;
      }[];
      expect(a[0].body).toEqual({
        id: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
        object: 'event',
        type: 'order.paid',
        created: FROZEN_NOW.toISOString(),
        api_version: '2026-10-01',
        resource_version: 4,
        data: {
          object: {
            id: event.aggregateId,
            object: 'order',
            shop_order_id: shopOrders.find((s) => s.shopId === wa.shop.id)!
              .shopOrderId,
            status: 'PAID',
            total: { amount: 5000, currency: 'EUR' },
            lines: [
              {
                product_id: pa1,
                title: 'Alpha one',
                quantity: 1,
                unit_price: { amount: 2000, currency: 'EUR' },
              },
              {
                product_id: pa2,
                title: 'Alpha two',
                quantity: 2,
                unit_price: { amount: 1500, currency: 'EUR' },
              },
            ],
          },
        },
      });
      // 2 x 1500 + 2000 = 5000 for A, 3000 for B: neither shop sees the other's lines, amounts or the buyer
      expect(a[0].record.body).not.toContain(pb1);
      expect(a[0].record.body).not.toMatch(/"amount":3000\b/); // not a bare substring: ids are random hex
      expect(a[0].record.body).not.toContain(buyer);
      expect(b[0].record.body).not.toContain(pa1);
      expect(b[0].record.body).not.toContain(pa2);
      expect(b[0].record.body).not.toMatch(/"amount":(5000|2000|1500)\b/);
      expect(b[0].record.body).not.toContain(buyer);
      expect(b[0].body.data.object).toMatchObject({
        total: { amount: 3000, currency: 'EUR' },
      });
      expect(a[0].body.id).not.toBe(b[0].body.id);
      expect(a[0].message).toMatchObject({
        endpointId: ea.id,
        eventId: a[0].body.id,
        kind: 'event',
        attempt: 1,
      });
    });

    it('S43 AS-24: endpoints pinned to different versions get the same event id in their own shape', async () => {
      const w = await t.seedWorld();
      const old = await endpoint(w, ['order.paid'], {
        apiVersion: '2026-01-15',
      });
      const latest = await endpoint(w, ['order.paid'], {
        apiVersion: '2026-10-01',
      });
      await feed(orders(), [
        orderPaidEvent({
          shops: [{ shopId: w.shop.id, lines: [{ unitPriceMinor: 5000 }] }],
        }),
      ]);

      const [o] = await deliveriesOf(old.id);
      const [l] = await deliveriesOf(latest.id);
      expect(o.body.api_version).toBe('2026-01-15');
      expect(l.body.api_version).toBe('2026-10-01');
      expect(o.body.id).toBe(l.body.id);
      const oldObject = o.body.data.object as Record<string, unknown>;
      expect(oldObject.total).toBe(5000); // a plain integer in the older shape
      expect(String(oldObject.currency).toLowerCase()).toBe('eur');
      expect(l.body.data.object).toMatchObject({
        total: { amount: 5000, currency: 'EUR' },
      });
    });

    it('S43 AS-25: only enabled endpoints of the event shop subscribed to the type get a delivery; a shop with no endpoint is acknowledged', async () => {
      const w = await t.seedWorld();
      const other = await t.seedWorld();
      const empty = await t.seedWorld();
      const e1 = await endpoint(w, ['product.stock_low']);
      const e2 = await endpoint(w, ['order.paid']);
      const disabled = await t
        .as(w.owner)
        .post(`${t.base(w)}/${e2.id}/disable`)
        .send({});
      expect(disabled.status).toBe(200);
      const e3 = await endpoint(other, ['order.paid']);

      const event = orderPaidEvent({ shops: [{ shopId: w.shop.id }] });
      await feed(orders(), [event]);

      expect(allPending()).toEqual([]);
      for (const id of [e1.id, e2.id, e3.id])
        expect(await deliveriesOf(id)).toEqual([]);
      expect(await receipts(ORDERS, event.eventId)).toEqual([
        { status: 'PROCESSED' },
      ]);

      const noEndpoints = orderPaidEvent({
        shops: [{ shopId: empty.shop.id }],
      });
      expect(await feed(orders(), [noEndpoints])).toEqual([]);
      expect(await receipts(ORDERS, noEndpoints.eventId)).toEqual([
        { status: 'PROCESSED' },
      ]);
    });

    it('S43 AS-26: cancel and refund go to the listed shops with the status and the reason, no amounts and no other shop', async () => {
      const wa = await t.seedWorld();
      const wb = await t.seedWorld();
      const ca = await endpoint(wa, ['order.cancelled', 'order.refunded']);
      const cb = await endpoint(wb, ['order.cancelled', 'order.refunded']);

      const cancelled = orderStatusEvent('order.cancelled', {
        shopIds: [wa.shop.id, wb.shop.id],
        orderVersion: 5,
      });
      const refunded = orderStatusEvent('order.refunded', {
        shopIds: [wa.shop.id],
        orderVersion: 6,
      });
      expect(await feed(orders(), [cancelled, refunded])).toEqual([]);

      const a = await deliveriesOf(ca.id);
      const b = await deliveriesOf(cb.id);
      expect(a.map((d) => d.body.type)).toEqual([
        'order.cancelled',
        'order.refunded',
      ]);
      expect(b.map((d) => d.body.type)).toEqual(['order.cancelled']);
      expect(a[0].body).toMatchObject({
        resource_version: 5,
        data: {
          object: {
            id: cancelled.aggregateId,
            object: 'order',
            status: 'CANCELLED',
            reason: 'payment_failed',
          },
        },
      });
      expect(a[1].body).toMatchObject({
        resource_version: 6,
        data: {
          object: {
            id: refunded.aggregateId,
            object: 'order',
            status: 'REFUNDED',
            reason: 'requested_by_customer',
          },
        },
      });
      for (const d of [...a, ...b]) {
        expect(JSON.stringify(d.body.data.object)).not.toMatch(
          /amount|total|price/i,
        );
        expect(d.record.body).not.toContain(wa.shop.id);
        expect(d.record.body).not.toContain(wb.shop.id);
      }
    });
  });

  describe('products and payouts (AS-27, AS-28, AS-29, AS-32)', () => {
    it('S43 AS-27: the five full-state product events map to four webhook types, copied from the event (no product table is read), with resource_version = productVersion', async () => {
      const w = await t.seedWorld();
      const e = await endpoint(w, [
        'product.created',
        'product.updated',
        'product.archived',
        'product.deleted',
      ]);
      const productId = uuidv7(); // no such row exists anywhere: the event is the only source
      const common = { shopId: w.shop.id, productId, title: 'Blue mug' };
      const events = [
        productEvent('created', { ...common, productVersion: 1 }),
        productEvent('updated', {
          ...common,
          productVersion: 2,
          priceMinor: 1999,
          changedFields: ['priceMinor'],
        }),
        productEvent('archived', { ...common, productVersion: 3 }),
        productEvent('restored', { ...common, productVersion: 4 }),
        productEvent('deleted', { ...common, productVersion: 5 }),
        // transitional notification: ignored
        envelope('catalog.product_changed', productId, { productId }),
      ];
      expect(await feed(products(), events)).toEqual([]);

      const got = await deliveriesOf(e.id);
      expect(got.map((d) => [d.body.type, d.body.resource_version])).toEqual([
        ['product.created', 1],
        ['product.updated', 2],
        ['product.archived', 3],
        ['product.updated', 4],
        ['product.deleted', 5],
      ]);
      expect(got[1].body.data.object).toEqual({
        id: productId,
        object: 'product',
        title: 'Blue mug',
        price: { amount: 1999, currency: 'EUR' },
        stock: 10,
        status: 'ACTIVE',
        changed_fields: ['priceMinor'],
      });
      expect(got[4].body.data.object).toEqual({
        id: productId,
        object: 'product',
      });
      expect(new Set(got.map((d) => d.body.id)).size).toBe(5);
    });

    it('S43 AS-28: a snapshot at or below 5 whose changed fields name quantity yields product.stock_low once per product per UTC day; quantity 6 yields nothing', async () => {
      const w = await t.seedWorld();
      const e = await endpoint(w, ['product.stock_low']);
      const productId = uuidv7();
      const at = (iso: string) => new Date(iso);
      const low = (n: number, iso: string, extra = {}) =>
        productEvent('updated', {
          shopId: w.shop.id,
          productId,
          quantity: n,
          changedFields: ['quantity'],
          productVersion: n + 10,
          occurredAt: at(iso),
          ...extra,
        });
      await feed(products(), [
        low(6, '2026-10-06T08:00:00Z'),
        low(5, '2026-10-06T09:00:00Z'),
        low(3, '2026-10-06T23:59:59Z'), // same UTC day: same deterministic id, nothing more
        low(2, '2026-10-07T00:00:00Z'), // next UTC day: emits again
        productEvent('updated', {
          shopId: w.shop.id,
          productId,
          quantity: 1,
          changedFields: ['title'],
          occurredAt: at('2026-10-08T10:00:00Z'),
        }),
      ]);

      const got = await deliveriesOf(e.id);
      expect(got.map((d) => d.body.type)).toEqual([
        'product.stock_low',
        'product.stock_low',
      ]);
      expect(got[0].body.data.object).toEqual({
        id: productId,
        object: 'product',
        title: 'Blue mug',
        stock: 5,
        threshold: 5,
      });
      expect(got[0].body.resource_version).toBeNull();
      expect(got[0].body.id).not.toBe(got[1].body.id);
    });

    it('S43 AS-29: sandbox product events create nothing; payout.paid and payout.failed map to the payout resource; other payout events are ignored', async () => {
      const w = await t.seedWorld();
      const e = await endpoint(w, [
        'product.updated',
        'payout.paid',
        'payout.failed',
      ]);
      await feed(products(), [
        productEvent('updated', { shopId: w.shop.id, isSandbox: true }),
      ]);
      expect(await deliveriesOf(e.id)).toEqual([]);

      const paid = payoutEvent('paid', {
        shopId: w.shop.id,
        payoutVersion: 3,
        amountMinor: 98_700,
      });
      const failed = payoutEvent('failed', {
        shopId: w.shop.id,
        payoutVersion: 2,
      });
      const cancelled = envelope('payout.cancelled', uuidv7(), {
        payoutId: uuidv7(),
        shopId: w.shop.id,
      });
      expect(await feed(payouts(), [paid, failed, cancelled])).toEqual([]);

      const got = await deliveriesOf(e.id);
      expect(got).toHaveLength(2);
      expect(got[0].body).toMatchObject({
        type: 'payout.paid',
        resource_version: 3,
        data: {
          object: {
            id: paid.payload.payoutId,
            object: 'payout',
            amount: { amount: 98_700, currency: 'EUR' },
            period_start: '2026-09-01',
            status: 'paid',
            transfer_ref: 'tr_1',
          },
        },
      });
      expect(got[1].body).toMatchObject({
        type: 'payout.failed',
        resource_version: 2,
        data: {
          object: {
            id: failed.payload.payoutId,
            status: 'failed',
            failure_code: 'account_closed',
          },
        },
      });
    });

    it('S43 AS-32: out-of-order product versions are both delivered, in the order consumed, each with its own resource_version', async () => {
      const w = await t.seedWorld();
      const e = await endpoint(w, ['product.updated']);
      const productId = uuidv7();
      await feed(products(), [
        productEvent('updated', {
          shopId: w.shop.id,
          productId,
          productVersion: 7,
          occurredAt: new Date('2026-10-06T12:00:02Z'),
        }),
        productEvent('updated', {
          shopId: w.shop.id,
          productId,
          productVersion: 6,
          occurredAt: new Date('2026-10-06T12:00:01Z'),
        }),
      ]);

      const got = await deliveriesOf(e.id);
      expect(got.map((d) => d.body.resource_version)).toEqual([7, 6]);
      expect(got.map((d) => d.body.created)).toEqual([
        '2026-10-06T12:00:02.000Z',
        '2026-10-06T12:00:01.000Z',
      ]);
    });
  });

  describe('duplicates and poison (AS-30, AS-31)', () => {
    it('S43 AS-30: consuming one order twice, then at the same moment, leaves one delivery and one message per endpoint and one receipt (20 rounds)', async () => {
      const w = await t.seedWorld();
      const e1 = await endpoint(w, ['order.paid']);
      const e2 = await endpoint(w, ['order.paid']);
      for (let round = 0; round < 20; round++) {
        const event = orderPaidEvent({ shops: [{ shopId: w.shop.id }] });
        await feed(orders(), [event]);
        await feed(orders(), [event]);
        await Promise.all(
          Array.from({ length: 4 }, () => feed(orders(), [event])),
        );

        for (const e of [e1, e2]) {
          const mine = await deliveriesOf(e.id);
          expect(mine).toHaveLength(round + 1); // exactly one delivery per consumed order, whatever the repeats
          expect(mine.at(-1)!.record.state).toBe('queued');
        }
        expect(await receipts(ORDERS, event.eventId)).toEqual([
          { status: 'PROCESSED' },
        ]);
      }
      expect(lane().pending(e1.id)).toHaveLength(20);
      expect(lane().pending(e2.id)).toHaveLength(20);
      // the id is the same on a re-consume: the 20 messages of one endpoint are 20 distinct events
      expect(
        new Set(
          lane()
            .pending(e1.id)
            .map((m) => m.eventId),
        ).size,
      ).toBe(20);
    });

    it('S43 AS-31: a payload without shopOrders, a cancel without shopIds, the wrong version and a non-JSON value are dead-lettered with nothing created, and a valid event behind them is routed', async () => {
      const w = await t.seedWorld();
      const e = await endpoint(w, ['order.paid', 'order.cancelled']);
      const noShopOrders = orderPaidEvent({ shops: [{ shopId: w.shop.id }] });
      delete noShopOrders.payload.shopOrders;
      const noShopIds = orderStatusEvent('order.cancelled', {}); // S10 field absent, fallback flag off
      const wrongVersion = {
        ...orderPaidEvent({ shops: [{ shopId: w.shop.id }] }),
        version: 2,
      };
      const valid = orderPaidEvent({ shops: [{ shopId: w.shop.id }] });

      const dead = await feed(orders(), [
        noShopOrders,
        noShopIds,
        wrongVersion,
        valid,
      ]);

      expect(dead.map((d) => d.eventId)).toEqual([
        noShopOrders.eventId,
        noShopIds.eventId,
        wrongVersion.eventId,
      ]);
      expect(dead.map((d) => d.reason)).toEqual([
        'INVALID_PAYLOAD',
        'PERMANENT',
        'UNSUPPORTED_VERSION',
      ]);
      const notJson = parseEnvelope(Buffer.from('this is not json'));
      expect(notJson).toMatchObject({ ok: false, code: 'INVALID_ENVELOPE' });

      const got = await deliveriesOf(e.id);
      expect(got).toHaveLength(1);
      expect(got[0].body.data.object).toMatchObject({ id: valid.aggregateId });
      for (const bad of [noShopOrders, noShopIds, wrongVersion])
        expect(await receipts(ORDERS, bad.eventId)).toEqual([]);
      expect(await receipts(ORDERS, valid.eventId)).toEqual([
        { status: 'PROCESSED' },
      ]);
    });
  });

  describe('dependency faults and freshness (AS-33, AS-34)', () => {
    it('S43 AS-33: while the lane queue rejects the write the event is not acknowledged (no receipt); after recovery every endpoint has exactly one message', async () => {
      const w = await t.seedWorld();
      const e1 = await endpoint(w, ['order.paid']);
      const e2 = await endpoint(w, ['order.paid']);
      const event = orderPaidEvent({ shops: [{ shopId: w.shop.id }] });

      const original = queue.enqueueBatch.bind(queue);
      queue.enqueueBatch = () => Promise.reject(new Error('queue unavailable'));
      try {
        await expect(feed(orders(), [event])).rejects.toThrow(
          'queue unavailable',
        );
      } finally {
        queue.enqueueBatch = original; // L-013: the next test starts with a working queue
      }
      expect(allPending()).toEqual([]);
      expect(
        (await receipts(ORDERS, event.eventId)).filter(
          (r) => r.status === 'PROCESSED',
        ),
      ).toEqual([]);

      await feed(orders(), [event]); // the redelivery
      await feed(orders(), [event]); // and a repeat of it
      expect(lane().pending(e1.id)).toHaveLength(1);
      expect(lane().pending(e2.id)).toHaveLength(1);
      expect(await receipts(ORDERS, event.eventId)).toEqual([
        { status: 'PROCESSED' },
      ]);
    });

    it('S43 AS-34: a disable committed on one instance is honoured by another instance routing right after (no per-process copy)', async () => {
      const queueB = new InMemoryTaskQueue();
      const b = await createWebhookKit({
        extraImports: [WebhooksProjectorModule, WebhooksWorkerModule],
        overrides: [{ provide: TaskQueue, useValue: queueB }],
      });
      try {
        const w = await t.seedWorld();
        const e = await endpoint(w, ['order.paid']);
        const routeOnB = () =>
          feed(b.app.get(WebhookOrdersConsumer), [
            orderPaidEvent({ shops: [{ shopId: w.shop.id }] }),
          ]);

        await routeOnB(); // B now holds the subscription
        expect(
          queueB.sent.filter((m) => m.queue === WEBHOOK_QUEUE),
        ).toHaveLength(1);

        const res = await t
          .as(w.owner)
          .post(`${t.base(w)}/${e.id}/disable`)
          .send({});
        expect(res.status).toBe(200);
        await routeOnB();
        expect(
          queueB.sent.filter((m) => m.queue === WEBHOOK_QUEUE),
        ).toHaveLength(1);

        // and the events list: A edits, B routes the new subscription at once
        const enable = await t
          .as(w.owner)
          .post(`${t.base(w)}/${e.id}/enable`)
          .send({});
        expect(enable.status).toBe(200);
        const patch = await t
          .as(w.owner)
          .patch(`${t.base(w)}/${e.id}`)
          .send({ events: ['product.created'] });
        expect(patch.status).toBe(200);
        await routeOnB();
        expect(
          queueB.sent.filter((m) => m.queue === WEBHOOK_QUEUE),
        ).toHaveLength(1);
        await feed(b.app.get(WebhookProductsConsumer), [
          productEvent('created', { shopId: w.shop.id }),
        ]);
        expect(
          queueB.sent.filter((m) => m.queue === WEBHOOK_QUEUE),
        ).toHaveLength(2);
      } finally {
        // closing an app closes the process-wide database connection both instances share: B is closed after A, below
        second = b;
      }
    }, 120_000);
  });

  describe('shop deleted (AS-66)', () => {
    it('S43 AS-66: tenancy.shop_deleted purges endpoints, history and log items in batches of at most 1,000 and queued deliveries are never sent; a repeat changes nothing; a payload without shopId is dead-lettered', async () => {
      const w = await t.seedWorld();
      const keep = await t.seedWorld();
      const receiver = await t.startReceiver();
      const mine = [
        await endpoint(w, ['order.paid'], { url: receiver.url() }),
        await endpoint(w, ['order.paid']),
        await endpoint(w, ['order.paid']),
      ];
      const survivor = await endpoint(keep, ['order.paid']);
      await feed(orders(), [
        orderPaidEvent({
          shops: [{ shopId: w.shop.id }, { shopId: keep.shop.id }],
        }),
      ]);
      const queued = lane().pending(mine[0].id)[0];
      expect(queued).toBeDefined();
      expect(
        await t.rows(
          `SELECT 1 FROM "WebhookEndpointHistory" WHERE "shopId" = :shopId`,
          { shopId: w.shop.id },
        ),
      ).not.toEqual([]);

      const repo = t.app.get(EndpointRepository, { strict: false });
      const batches = jest.spyOn(repo, 'deleteForShop');
      const event = shopDeletedEvent(w.shop.id);
      try {
        expect(await feed(shopDeleted(), [event])).toEqual([]);
        expect(batches.mock.calls.length).toBeGreaterThan(0);
        for (const call of batches.mock.calls)
          expect(call[1]).toBeLessThanOrEqual(1000);
      } finally {
        batches.mockRestore();
      }

      for (const e of mine) {
        expect(await repo.findForDelivery(e.id)).toBeNull();
        expect(
          await log().getDelivery(e.id, queued.eventId, t.clock.now()),
        ).toBeNull();
      }
      expect(
        await t.rows(
          `SELECT 1 FROM "WebhookEndpointHistory" WHERE "shopId" = :shopId`,
          { shopId: w.shop.id },
        ),
      ).toEqual([]);
      expect(
        await t.rows(
          `SELECT 1 FROM "WebhookShopCounter" WHERE "shopId" = :shopId AND endpoints > 0`,
          {
            shopId: w.shop.id,
          },
        ),
      ).toEqual([]);
      expect(await repo.findForDelivery(survivor.id)).not.toBeNull();

      // the message that was already queued is never sent
      expect(await t.app.get(WebhookDeliveryService).handle(queued, 1)).toBe(
        'skipped',
      );
      expect(receiver.requests).toHaveLength(0);

      // a repeat and a poison payload
      expect(await feed(shopDeleted(), [event])).toEqual([]);
      const poison: SourceEvent = {
        ...shopDeletedEvent(keep.shop.id),
        payload: { shopVersion: 3 },
      };
      expect(
        (await feed(shopDeleted(), [poison])).map((d) => d.eventId),
      ).toEqual([poison.eventId]);
      expect(await repo.findForDelivery(survivor.id)).not.toBeNull();
      expect(await receipts('webhook-shop-deleted', event.eventId)).toEqual([
        { status: 'PROCESSED' },
      ]);
    });
  });
});
