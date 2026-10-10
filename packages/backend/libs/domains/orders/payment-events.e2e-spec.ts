import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type { ProcessWebhookPayload } from './application/order.job-types';
import {
  PaymentFailed,
  PaymentRefunded,
  PaymentSucceeded,
} from './application/events/payment-events';
import { OrderJobs } from './infra/order.jobs';
import { PaymentsEventsConsumer } from './infra/payments-events.consumer';
import {
  createOrdersApp,
  historyOf,
  orderRow,
  reservationsOf,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

describe('Orders: payment result consumer', () => {
  let t: OrdersTestApp;
  let consumer: PaymentsEventsConsumer;
  let jobs: OrderJobs;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createOrdersApp();
    consumer = t.app.get(PaymentsEventsConsumer);
    jobs = t.app.get(OrderJobs);
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const reservedOrder = async (quantity = 1) => {
    const { products } = await seedShopWithProducts(t.app, [
      { priceMinor: 2_500, quantity: 10, currency: 'EUR' },
    ]);
    const user = await t.newUser();
    await t
      .as(user)
      .put(`/api/cart/items/${products[0].id}`)
      .send({ quantity });
    const res = await t
      .as(user)
      .post('/api/checkout')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({});
    expect(res.status).toBe(202);
    return {
      user,
      product: products[0],
      orderId: res.body.orderId as string,
      total: 2_500 * quantity,
    };
  };
  const payload = (
    orderId: string,
    userId: string,
    over: Record<string, unknown> = {},
  ) => ({
    paymentId: randomUUID(),
    paymentRef: `pi_${randomUUID()}`,
    orderId,
    userId,
    amountMinor: 2_500,
    currency: 'EUR',
    occurredAt: new Date().toISOString(),
    ...over,
  });
  const succeeded = (
    orderId: string,
    userId: string,
    over: Record<string, unknown> = {},
  ) => {
    const p = payload(orderId, userId, over);
    return PaymentSucceeded.create(p.paymentId as string, 1, p as never);
  };
  const types = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId))
      .filter((r) => r.kind === 'event')
      .map((r) => r.type);

  it('S10 AS-50: the same payment_succeeded delivered twice makes one transition and one order.paid', async () => {
    const { user, orderId } = await reservedOrder();
    const event = succeeded(orderId, user.id);
    await consumer.project([event]);
    await consumer.project([event]);
    const row = await orderRow(t.app, orderId);
    expect([row.status, row.paymentRef]).toEqual([
      'PAID',
      (event.payload as { paymentRef: string }).paymentRef,
    ]);
    expect(await types(orderId)).toEqual(['order.reserved', 'order.paid']);
    expect(
      (await historyOf(t.app, orderId)).filter((h) => h.toStatus === 'PAID'),
    ).toHaveLength(1);
    expect((await historyOf(t.app, orderId)).at(-1)?.actor).toBe(
      'system:consumer',
    );
  });

  it('S10 AS-50: a missing orderId, a negative amount, a non-UUID orderId or an unknown type is a permanent failure without effect, and the next message is processed', async () => {
    const { user, orderId } = await reservedOrder();
    const good = succeeded(orderId, user.id);
    const broken = (over: Record<string, unknown>) =>
      ({ ...good, payload: { ...good.payload, ...over } }) as EventEnvelope;
    const bad: EventEnvelope[] = [
      broken({ orderId: undefined }),
      broken({ amountMinor: -5 }),
      broken({ orderId: 'not-a-uuid' }),
      { ...good, type: 'payments.payment_exploded' } as EventEnvelope,
    ];
    for (const message of bad)
      await expect(consumer.project([message])).rejects.toBeInstanceOf(
        PermanentError,
      );
    expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');
    expect(await types(orderId)).toEqual(['order.reserved']);

    await consumer.project([good]);
    expect((await orderRow(t.app, orderId)).status).toBe('PAID');
  });

  it('S10 AS-50: a payment whose amount or currency differs from the order is refused as permanent and pays nothing', async () => {
    const { user, orderId } = await reservedOrder();
    await expect(
      consumer.project([succeeded(orderId, user.id, { amountMinor: 2_400 })]),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      consumer.project([succeeded(orderId, user.id, { currency: 'USD' })]),
    ).rejects.toBeInstanceOf(PermanentError);
    expect((await orderRow(t.app, orderId)).status).toBe('RESERVED');
  });

  it('S10 AS-50: the webhook and the payments message racing for one payment give one PAID and one order.paid', async () => {
    const { user, orderId } = await reservedOrder();
    const ref = `pi_${randomUUID()}`;
    t.payments.statuses.set(ref, {
      status: 'COMPLETED',
      amountMinor: 2_500,
      currency: 'EUR',
    });
    const stripeBody = JSON.stringify({
      id: 'evt_race',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: ref,
          amount: 2_500,
          amount_received: 2_500,
          currency: 'eur',
          metadata: { orderId },
        },
      },
    });
    // the webhook is acknowledged and queued first (same as production), then both paths run at once
    const { createHmac } = await import('node:crypto');
    const ts = Math.floor(t.clock.now().getTime() / 1000);
    const header = `t=${ts},v1=${createHmac('sha256', 'whsec_orders_kit_current_secret').update(`${ts}.${stripeBody}`).digest('hex')}`;
    const ack = await t
      .http()
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(stripeBody);
    expect(ack.status).toBe(200);
    const [job] = await probe.find('orders.process-webhook', {
      eventId: 'evt_race',
    });
    const ctx = {
      jobId: 'x',
      attempt: 1,
      maxAttempts: 8,
      isLastAttempt: false,
      heartbeat: async () => undefined,
      signal: new AbortController().signal,
    };
    await Promise.all([
      jobs.processWebhook(job.payload as ProcessWebhookPayload, ctx),
      consumer.project([succeeded(orderId, user.id, { paymentRef: ref })]),
    ]);
    expect((await orderRow(t.app, orderId)).status).toBe('PAID');
    expect(await types(orderId)).toEqual(['order.reserved', 'order.paid']);
    expect(
      (await historyOf(t.app, orderId)).filter((h) => h.toStatus === 'PAID'),
    ).toHaveLength(1);
  });

  it('S10 AS-50: payment_failed cancels a RESERVED order (payment_failed) and returns the stock; payment_refunded refunds a PAID order', async () => {
    const failed = await reservedOrder(2);
    const p = payload(failed.orderId, failed.user.id, { amountMinor: 5_000 });
    await consumer.project([
      PaymentFailed.create(p.paymentId as string, 1, p as never),
    ]);
    const row = await orderRow(t.app, failed.orderId);
    expect([row.status, row.cancelReason]).toEqual([
      'CANCELLED',
      'payment_failed',
    ]);
    expect(await stockOf(t.app, [failed.product.id])).toEqual({
      [failed.product.id]: 10,
    });
    await consumer.project([
      PaymentFailed.create(p.paymentId as string, 1, p as never),
    ]);
    expect(await types(failed.orderId)).toEqual([
      'order.reserved',
      'order.cancelled',
    ]);

    const paid = await reservedOrder();
    await consumer.project([succeeded(paid.orderId, paid.user.id)]);
    const refund = payload(paid.orderId, paid.user.id);
    await consumer.project([
      PaymentRefunded.create(refund.paymentId as string, 1, refund as never),
    ]);
    expect((await orderRow(t.app, paid.orderId)).status).toBe('REFUNDED');
    expect(
      (await reservationsOf(t.app, paid.orderId)).map((r) => r.status),
    ).toEqual(['CONVERTED']);
    expect(await types(paid.orderId)).toEqual([
      'order.reserved',
      'order.paid',
      'order.refunded',
    ]);
  });
});
