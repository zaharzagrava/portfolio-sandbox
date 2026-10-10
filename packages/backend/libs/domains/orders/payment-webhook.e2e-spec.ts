import { createHmac, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import {
  orderEventSchemas,
  webhookAckSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import type { ProcessWebhookPayload } from './application/order.job-types';
import { OrderJobs } from './infra/order.jobs';
import {
  KIT_WEBHOOK_SECRET,
  KIT_WEBHOOK_SECRET_PREVIOUS,
  createOrdersApp,
  historyOf,
  orderRow,
  reservationsOf,
  rows,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

const MIN = 60_000;

describe('Payment webhook: signature, dedupe, async processing and out-of-order events', () => {
  let t: OrdersTestApp;
  let probe: JobsTestProbe;
  let jobs: OrderJobs;

  beforeAll(async () => {
    t = await createOrdersApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
    jobs = t.app.get(OrderJobs);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;
  const MAX_ATTEMPTS = 8;
  const result = (event: string) =>
    MetricsRegistry.value('orders_webhook_events_total', { result: event }) ??
    0;

  /** A RESERVED order of total 2500 EUR (one product, price 2500). */
  const reservedOrder = async (quantity = 1) => {
    const { products } = await seedShopWithProducts(t.app, [
      { title: 'Gadget', priceMinor: 2_500, quantity: 10, currency: 'EUR' },
    ]);
    const product = products[0];
    const user = await t.newUser();
    expect(
      (await t.as(user).put(`/api/cart/items/${product.id}`).send({ quantity }))
        .status,
    ).toBe(200);
    const res = await t
      .as(user)
      .post('/api/checkout')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({});
    expect(res.status).toBe(202);
    return {
      user,
      product,
      orderId: res.body.orderId as string,
      total: 2_500 * quantity,
    };
  };

  const stripeEvent = (
    type: string,
    over: {
      id?: string;
      orderId?: string | null;
      paymentRef?: string;
      amount?: number;
      currency?: string;
      refunded?: number;
    } = {},
  ) => {
    const paymentRef = over.paymentRef ?? `pi_${randomUUID()}`;
    const metadata =
      over.orderId === null || over.orderId === undefined
        ? {}
        : { orderId: over.orderId };
    const object =
      type === 'charge.refunded'
        ? {
            id: `ch_${randomUUID()}`,
            payment_intent: paymentRef,
            amount: over.amount ?? 2_500,
            amount_refunded: over.refunded ?? over.amount ?? 2_500,
            currency: over.currency ?? 'eur',
            metadata,
          }
        : {
            id: paymentRef,
            amount: over.amount ?? 2_500,
            amount_received: over.amount ?? 2_500,
            currency: over.currency ?? 'eur',
            metadata,
          };
    return { id: over.id ?? `evt_${randomUUID()}`, type, data: { object } };
  };
  const sign = (
    raw: string,
    {
      secret = KIT_WEBHOOK_SECRET,
      timestamp,
    }: { secret?: string; timestamp?: number } = {},
  ) => {
    const ts = timestamp ?? Math.floor(t.clock.now().getTime() / 1000);
    return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  };
  const post = (
    raw: string,
    header?: string,
    contentType = 'application/json',
  ) => {
    const req = t
      .http()
      .post('/api/webhooks/stripe')
      .set('Content-Type', contentType);
    return (
      header === undefined ? req : req.set('Stripe-Signature', header)
    ).send(raw);
  };
  const send = (event: object, options: Parameters<typeof sign>[1] = {}) => {
    const raw = JSON.stringify(event);
    return post(raw, sign(raw, options));
  };
  const inbox = (eventId?: string) =>
    rows<{
      eventId: string;
      status: string;
      detail: string | null;
      attempts: number;
    }>(
      t.app,
      `SELECT "eventId", "status", "detail", "attempts" FROM "ProcessedWebhookEvent" WHERE "provider" = 'stripe' ${eventId ? 'AND "eventId" = :eventId' : ''} ORDER BY "eventId"`,
      { eventId },
    );
  const queued = async (eventId?: string) =>
    (
      await probe.find('orders.process-webhook', eventId ? { eventId } : {})
    ).map((j) => j.payload as ProcessWebhookPayload);
  const ctx = (attempt = 1) => ({
    jobId: 'test',
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    isLastAttempt: attempt >= MAX_ATTEMPTS,
    heartbeat: async () => undefined,
    signal: new AbortController().signal,
  });
  const run = async (eventId: string, attempt = 1) => {
    const [payload] = await queued(eventId);
    return jobs.processWebhook(payload, ctx(attempt));
  };
  const completed = (
    paymentRef: string,
    amountMinor = 2_500,
    currency = 'EUR',
  ) =>
    t.payments.statuses.set(paymentRef, {
      status: 'COMPLETED',
      amountMinor,
      currency,
    });
  const eventTypes = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId))
      .filter((r) => r.kind === 'event')
      .map((r) => r.type);
  const refundTasks = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId)).filter((r) => r.kind === 'task');

  describe('acknowledge first, apply after (AS-41 to AS-43)', () => {
    it('S10 AS-41: 200 after the event is stored and queued while the order is still RESERVED; the job then pays it with every side effect', async () => {
      const { user, orderId } = await reservedOrder();
      const event = stripeEvent('payment_intent.succeeded', {
        orderId,
        paymentRef: 'pi_41',
        id: 'evt_41',
      });
      completed('pi_41');

      const res = await send(event);
      expect(res.status).toBe(200);
      expect(webhookAckSchema.parse(res.body)).toEqual({ received: true });
      expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');
      expect((await inbox('evt_41'))[0].status).toBe('RECEIVED');
      expect(await queued('evt_41')).toHaveLength(1);

      t.realtime.published.length = 0;
      const before = await orderRow(t.app, orderId);
      await run('evt_41');
      const after = await orderRow(t.app, orderId);
      expect([after.status, after.version, after.paymentRef]).toEqual([
        'PAID',
        before.version + 1,
        'pi_41',
      ]);
      expect(
        (await reservationsOf(t.app, orderId)).map((r) => r.status),
      ).toEqual(['CONVERTED']);
      expect(
        (
          await rows<{ status: string }>(
            t.app,
            `SELECT "status" FROM "ShopOrder" WHERE "bisOrderId" = :id`,
            { id: orderId },
          )
        ).map((s) => s.status),
      ).toEqual(['PAID']);
      const history = await historyOf(t.app, orderId);
      expect(history.at(-1)).toMatchObject({
        fromStatus: 'RESERVED',
        toStatus: 'PAID',
        actor: 'system:webhook',
      });
      const paidRows = (await outboxRowsFor(t.app, orderId)).filter(
        (r) => r.type === 'order.paid',
      );
      expect(paidRows).toHaveLength(1);
      const paid = orderEventSchemas['order.paid'].parse(
        (paidRows[0].payload as { payload: unknown }).payload,
      );
      expect(paid).toMatchObject({
        orderId,
        userId: user.id,
        totalMinor: 2_500,
        paymentRef: 'pi_41',
      });
      expect(paid.lines).toHaveLength(1);
      expect(paid.shopOrders).toHaveLength(1);
      expect(
        t.realtime.published.filter(
          (p) => (p.data as { status: string }).status === 'PAID',
        ),
      ).toHaveLength(1);
      expect((await inbox('evt_41'))[0].status).toBe('PROCESSED');
      expect(t.payments.calls).toEqual(['pi_41']);
    });

    it('S10 AS-42: seven bad signature forms are 400 invalid_signature and store and queue nothing; exactly 300 s old is accepted', async () => {
      const { orderId } = await reservedOrder();
      const raw = JSON.stringify(
        stripeEvent('payment_intent.succeeded', { orderId, id: 'evt_42' }),
      );
      const nowSec = Math.floor(t.clock.now().getTime() / 1000);
      const changed = raw.replace('evt_42', 'evt_43');
      const spaced = JSON.stringify(JSON.parse(raw), null, 2);
      const forms: Array<[string, string, string | undefined]> = [
        ['no header', raw, undefined],
        ['another secret', raw, sign(raw, { secret: 'whsec_not_ours' })],
        ['body changed by a byte', changed, sign(raw)],
        ['re-serialised copy', spaced, sign(raw)],
        ['301 s in the past', raw, sign(raw, { timestamp: nowSec - 301 })],
        ['301 s in the future', raw, sign(raw, { timestamp: nowSec + 301 })],
        ['malformed header', raw, 'v1=abc;t=nope'],
      ];
      for (const [label, body, header] of forms) {
        const res = await post(body, header);
        expect([label, res.status, res.body.code]).toEqual([
          label,
          400,
          'invalid_signature',
        ]);
      }
      expect(await inbox()).toEqual([]);
      expect(await queued()).toEqual([]);

      const edge = await post(raw, sign(raw, { timestamp: nowSec - 300 }));
      expect(edge.status).toBe(200);
      expect(await inbox()).toHaveLength(1);
    });

    it('S10 AS-43: the same event twice, sequentially and ten at once, is stored once, queued once and answers duplicate after the first', async () => {
      const { orderId } = await reservedOrder();
      const event = stripeEvent('payment_intent.succeeded', {
        orderId,
        paymentRef: 'pi_43',
        id: 'evt_dup',
      });
      completed('pi_43');
      const first = await send(event);
      expect(first.body).toEqual({ received: true });
      const second = await send(event);
      expect(second.status).toBe(200);
      expect(webhookAckSchema.parse(second.body)).toEqual({
        received: true,
        duplicate: true,
      });

      const burst = stripeEvent('payment_intent.succeeded', {
        orderId,
        paymentRef: 'pi_43b',
        id: 'evt_burst',
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => send(burst)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(9);
      expect(await inbox('evt_dup')).toHaveLength(1);
      expect(await inbox('evt_burst')).toHaveLength(1);
      expect(await queued('evt_dup')).toHaveLength(1);
      expect(await queued('evt_burst')).toHaveLength(1);

      await run('evt_dup');
      await run('evt_dup'); // a redelivered job does nothing more
      expect(
        (await historyOf(t.app, orderId)).filter((h) => h.toStatus === 'PAID'),
      ).toHaveLength(1);
      expect(await eventTypes(orderId)).toEqual([
        'order.reserved',
        'order.paid',
      ]);
    });
  });

  describe('processing outcomes (AS-44 to AS-46)', () => {
    it('S10 AS-44: an unavailable status service keeps the event RECEIVED and retries; recovery pays once; eight failures end FAILED with the metric and the order untouched', async () => {
      const { orderId } = await reservedOrder();
      const event = stripeEvent('payment_intent.succeeded', {
        orderId,
        paymentRef: 'pi_44',
        id: 'evt_44',
      });
      expect((await send(event)).status).toBe(200);

      t.payments.failNext = 3;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect(run('evt_44', attempt)).rejects.toBeDefined();
        expect((await inbox('evt_44'))[0].status).toBe('RECEIVED');
      }
      completed('pi_44');
      await run('evt_44', 4);
      expect((await orderRow(t.app, orderId)).status).toBe('PAID');
      expect((await inbox('evt_44'))[0].status).toBe('PROCESSED');
      expect(
        (await historyOf(t.app, orderId)).filter((h) => h.toStatus === 'PAID'),
      ).toHaveLength(1);

      const second = await reservedOrder();
      const lost = stripeEvent('payment_intent.succeeded', {
        orderId: second.orderId,
        paymentRef: 'pi_44b',
        id: 'evt_44b',
      });
      expect((await send(lost)).status).toBe(200);
      t.payments.failNext = 100;
      const failedBefore = result('failed');
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
        await expect(run('evt_44b', attempt)).rejects.toBeDefined();
      expect((await inbox('evt_44b'))[0].status).toBe('FAILED');
      expect(result('failed')).toBe(failedBefore + 1);
      expect((await orderRow(t.app, second.orderId)).status).toBe('RESERVED');
    });

    it('S10 AS-45: a wrong amount, a wrong currency or a payment that is not completed is REJECTED with its reason, the order unchanged', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const cases: Array<
        [
          string,
          string,
          (orderId: string) => ReturnType<typeof stripeEvent>,
          () => void,
        ]
      > = [
        [
          'amount_mismatch',
          'amount',
          (orderId) =>
            stripeEvent('payment_intent.succeeded', {
              orderId,
              paymentRef: 'pi_a',
              amount: 2_400,
            }),
          () => completed('pi_a', 2_400),
        ],
        [
          'currency_mismatch',
          'currency',
          (orderId) =>
            stripeEvent('payment_intent.succeeded', {
              orderId,
              paymentRef: 'pi_c',
              currency: 'usd',
            }),
          () => completed('pi_c', 2_500, 'USD'),
        ],
        [
          'payment_not_completed',
          'not completed',
          (orderId) =>
            stripeEvent('payment_intent.succeeded', {
              orderId,
              paymentRef: 'pi_n',
            }),
          () =>
            t.payments.statuses.set('pi_n', {
              status: 'FAILED',
              amountMinor: 2_500,
              currency: 'EUR',
            }),
        ],
      ];
      for (const [reason, label, make, prepare] of cases) {
        const { orderId } = await reservedOrder();
        const event = make(orderId);
        prepare();
        expect((await send(event)).status).toBe(200);
        const before = result('rejected');
        await run(event.id);
        const stored = (await inbox(event.id))[0];
        expect([label, stored.status, stored.detail]).toEqual([
          label,
          'REJECTED',
          reason,
        ]);
        expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');
        expect(result('rejected')).toBe(before + 1);
      }
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('S10 AS-46: no orderId or an unknown order is UNMATCHED; an unhandled type is IGNORED; the response is always 200', async () => {
      const noOrder = stripeEvent('payment_intent.succeeded', {
        orderId: null,
        id: 'evt_u1',
      });
      const unknown = stripeEvent('payment_intent.succeeded', {
        orderId: randomUUID(),
        id: 'evt_u2',
      });
      const notUuid = stripeEvent('payment_intent.succeeded', {
        orderId: 'order-123',
        id: 'evt_u3',
      });
      const other = {
        id: 'evt_u4',
        type: 'customer.created',
        data: { object: { id: 'cus_1' } },
      };
      for (const e of [noOrder, unknown, notUuid, other])
        expect((await send(e)).status).toBe(200);
      for (const id of ['evt_u1', 'evt_u2', 'evt_u3', 'evt_u4']) await run(id);
      expect((await inbox()).map((r) => [r.eventId, r.status])).toEqual([
        ['evt_u1', 'UNMATCHED'],
        ['evt_u2', 'UNMATCHED'],
        ['evt_u3', 'UNMATCHED'],
        ['evt_u4', 'IGNORED'],
      ]);
    });
  });

  describe('out-of-order, failed and refunded payments (AS-47 to AS-49)', () => {
    it('S10 AS-47: a failure after success is IGNORED (order_already_paid); a success after hold expiry leaves the order CANCELLED and requests one refund, not two', async () => {
      const paid = await reservedOrder();
      const success = stripeEvent('payment_intent.succeeded', {
        orderId: paid.orderId,
        paymentRef: 'pi_47',
        id: 'evt_47',
      });
      completed('pi_47');
      await send(success);
      await run('evt_47');
      const failure = stripeEvent('payment_intent.payment_failed', {
        orderId: paid.orderId,
        paymentRef: 'pi_47',
        id: 'evt_47f',
      });
      await send(failure);
      await run('evt_47f');
      const f = (await inbox('evt_47f'))[0];
      expect([f.status, f.detail]).toEqual(['IGNORED', 'order_already_paid']);
      expect((await orderRow(t.app, paid.orderId)).status).toBe('PAID');

      const late = await reservedOrder();
      t.clock.set(new Date(t.clock.now().getTime() + 15 * MIN));
      await jobs.expireReservation({ orderId: late.orderId });
      expect((await orderRow(t.app, late.orderId)).status).toBe('CANCELLED');
      const after = stripeEvent('payment_intent.succeeded', {
        orderId: late.orderId,
        paymentRef: 'pi_47late',
        id: 'evt_47late',
      });
      completed('pi_47late');
      await send(after);
      await run('evt_47late');
      expect((await orderRow(t.app, late.orderId)).status).toBe('CANCELLED');
      expect((await inbox('evt_47late'))[0].status).toBe('PROCESSED');
      let tasks = await refundTasks(late.orderId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].type).toBe('orders.refund_requested');
      expect((tasks[0].payload as { body: unknown }).body).toEqual({
        orderId: late.orderId,
        paymentRef: 'pi_47late',
        amountMinor: 2_500,
        currency: 'EUR',
        reason: 'order_cancelled',
      });

      const again = stripeEvent('payment_intent.succeeded', {
        orderId: late.orderId,
        paymentRef: 'pi_47late',
        id: 'evt_47late2',
      });
      await send(again);
      await run('evt_47late2');
      tasks = await refundTasks(late.orderId);
      expect(tasks).toHaveLength(1);
    });

    it('S10 AS-48: a failed payment cancels a RESERVED order (payment_failed), returns the stock once and emits one order.cancelled; PENDING and CANCELLED stay as they are', async () => {
      const { orderId, product } = await reservedOrder(2);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 8 });
      const failed = stripeEvent('payment_intent.payment_failed', {
        orderId,
        id: 'evt_48',
      });
      await send(failed);
      await run('evt_48');
      const row = await orderRow(t.app, orderId);
      expect([row.status, row.cancelReason]).toEqual([
        'CANCELLED',
        'payment_failed',
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
      expect(await eventTypes(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);

      const repeat = stripeEvent('payment_intent.payment_failed', {
        orderId,
        id: 'evt_48b',
      });
      await send(repeat);
      await run('evt_48b');
      expect((await inbox('evt_48b'))[0].status).toBe('IGNORED');
      expect(await eventTypes(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
    });

    it('S10 AS-49: a full refund of a PAID order is REFUNDED with one event and the reservations stay CONVERTED; a partial refund only adds a history row', async () => {
      const full = await reservedOrder();
      completed('pi_49');
      await send(
        stripeEvent('payment_intent.succeeded', {
          orderId: full.orderId,
          paymentRef: 'pi_49',
          id: 'evt_49s',
        }),
      );
      await run('evt_49s');
      await send(
        stripeEvent('charge.refunded', {
          orderId: full.orderId,
          paymentRef: 'pi_49',
          id: 'evt_49r',
          amount: 2_500,
          refunded: 2_500,
        }),
      );
      await run('evt_49r');
      expect((await orderRow(t.app, full.orderId)).status).toBe('REFUNDED');
      expect(await eventTypes(full.orderId)).toEqual([
        'order.reserved',
        'order.paid',
        'order.refunded',
      ]);
      expect(
        (await reservationsOf(t.app, full.orderId)).map((r) => r.status),
      ).toEqual(['CONVERTED']);
      expect((await inbox('evt_49r'))[0].status).toBe('PROCESSED');

      const partial = await reservedOrder();
      completed('pi_49p');
      await send(
        stripeEvent('payment_intent.succeeded', {
          orderId: partial.orderId,
          paymentRef: 'pi_49p',
          id: 'evt_49ps',
        }),
      );
      await run('evt_49ps');
      await send(
        stripeEvent('charge.refunded', {
          orderId: partial.orderId,
          paymentRef: 'pi_49p',
          id: 'evt_49pr',
          amount: 2_500,
          refunded: 1_000,
        }),
      );
      await run('evt_49pr');
      expect((await orderRow(t.app, partial.orderId)).status).toBe('PAID');
      const history = await rows<{ reason: string; amountMinor: string }>(
        t.app,
        `SELECT "reason", "amountMinor" FROM "OrderEvent" WHERE "bisOrderId" = :id AND "reason" = 'partial_refund'`,
        { id: partial.orderId },
      );
      expect(history).toEqual([
        { reason: 'partial_refund', amountMinor: '1000' },
      ]);
      expect(await eventTypes(partial.orderId)).toEqual([
        'order.reserved',
        'order.paid',
      ]);
      await run('evt_49pr'); // a redelivered job adds no second row
      expect(
        (
          await rows(
            t.app,
            `SELECT 1 FROM "OrderEvent" WHERE "bisOrderId" = :id AND "reason" = 'partial_refund'`,
            { id: partial.orderId },
          )
        ).length,
      ).toBe(1);
    });

    it('S10 AS-49: a refund that arrives before the success is retried and applies once the order is PAID, or ends FAILED after eight attempts', async () => {
      const early = await reservedOrder();
      const refund = stripeEvent('charge.refunded', {
        orderId: early.orderId,
        paymentRef: 'pi_49e',
        id: 'evt_49e',
        amount: 2_500,
        refunded: 2_500,
      });
      await send(refund);
      await expect(run('evt_49e', 1)).rejects.toBeDefined();
      expect((await inbox('evt_49e'))[0].status).toBe('RECEIVED');
      completed('pi_49e');
      await send(
        stripeEvent('payment_intent.succeeded', {
          orderId: early.orderId,
          paymentRef: 'pi_49e',
          id: 'evt_49es',
        }),
      );
      await run('evt_49es');
      await run('evt_49e', 2);
      expect((await orderRow(t.app, early.orderId)).status).toBe('REFUNDED');

      const never = await reservedOrder();
      await send(
        stripeEvent('charge.refunded', {
          orderId: never.orderId,
          paymentRef: 'pi_49n',
          id: 'evt_49n',
          amount: 2_500,
          refunded: 2_500,
        }),
      );
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)
        await expect(run('evt_49n', attempt)).rejects.toBeDefined();
      expect((await inbox('evt_49n'))[0].status).toBe('FAILED');
    });
  });

  describe('races and transport (AS-51, AS-52)', () => {
    it('S10 AS-51: a success racing the buyer’s cancel ends in exactly one outcome, 50 times, with consistent stock, events and refund commands', async () => {
      const { products } = await seedShopWithProducts(t.app, [
        { priceMinor: 2_500, quantity: 100, currency: 'EUR' },
      ]);
      const product = products[0];
      let paidWins = 0;
      let cancelWins = 0;
      for (let i = 0; i < 50; i++) {
        const user = await t.newUser();
        await t
          .as(user)
          .put(`/api/cart/items/${product.id}`)
          .send({ quantity: 1 });
        const res = await t
          .as(user)
          .post('/api/checkout')
          .set('Idempotency-Key', `key-${randomUUID()}`)
          .send({});
        expect(res.status).toBe(202);
        const orderId = res.body.orderId as string;
        const ref = `pi_51_${i}`;
        completed(ref);
        const event = stripeEvent('payment_intent.succeeded', {
          orderId,
          paymentRef: ref,
          id: `evt_51_${i}`,
        });
        await send(event);

        const [cancel] = await Promise.all([
          t.as(user).post(`/api/orders/${orderId}/cancel`),
          run(`evt_51_${i}`),
        ]);
        const row = await orderRow(t.app, orderId);
        const types = await eventTypes(orderId);
        if (row.status === 'PAID') {
          paidWins += 1;
          expect(cancel.status).toBe(409);
          expect(cancel.body.code).toBe('order_not_cancellable');
          expect(types).toEqual(['order.reserved', 'order.paid']);
          expect(await refundTasks(orderId)).toHaveLength(0);
        } else {
          cancelWins += 1;
          expect(row.status).toBe('CANCELLED');
          expect(cancel.status).toBe(200);
          expect(types).toEqual(['order.reserved', 'order.cancelled']);
          expect(await refundTasks(orderId)).toHaveLength(1);
        }
      }
      // stock: every cancelled order returned its unit, every paid one kept it
      expect(await stockOf(t.app, [product.id])).toEqual({
        [product.id]: 100 - paidWins,
      });
      expect(paidWins + cancelWins).toBe(50);
    }, 300_000);

    it('S10 AS-52: a body over 64 KiB is 413, non-JSON or id-less bodies are 400 invalid_payload, the previous secret is accepted and others are not, GET is 405', async () => {
      const big = JSON.stringify({
        id: 'evt_big',
        type: 'x',
        pad: 'a'.repeat(70_000),
      });
      const bigRes = await post(big, sign(big));
      expect(bigRes.status).toBe(413);
      expect(await inbox()).toEqual([]);

      const notJson = 'this is not json';
      const text = await post(notJson, sign(notJson), 'text/plain');
      expect([text.status, text.body.code]).toEqual([400, 'invalid_payload']);
      for (const body of [
        JSON.stringify({ type: 'payment_intent.succeeded' }),
        JSON.stringify({ id: 'evt_x' }),
        JSON.stringify([1, 2]),
      ]) {
        const res = await post(body, sign(body));
        expect([res.status, res.body.code]).toEqual([400, 'invalid_payload']);
      }
      expect(await inbox()).toEqual([]);

      const rotated = JSON.stringify(
        stripeEvent('customer.created', { id: 'evt_rot' }),
      );
      expect(
        (
          await post(
            rotated,
            sign(rotated, { secret: KIT_WEBHOOK_SECRET_PREVIOUS }),
          )
        ).status,
      ).toBe(200);
      const refused = JSON.stringify(
        stripeEvent('customer.created', { id: 'evt_rot2' }),
      );
      const other = await post(
        refused,
        sign(refused, { secret: 'whsec_someone_else' }),
      );
      expect([other.status, other.body.code]).toEqual([
        400,
        'invalid_signature',
      ]);

      const get = await t.http().get('/api/webhooks/stripe');
      expect(get.status).toBe(405);
    });

    it('S10 AS-52: 301 forged requests from one address within a minute meet 429', async () => {
      const raw = JSON.stringify(
        stripeEvent('customer.created', { id: 'evt_forged' }),
      );
      let last = 0;
      for (let i = 0; i < 301; i++)
        last = (await post(raw, 'v1=forged')).status;
      expect(last).toBe(429);
    }, 120_000);
  });
});
