import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { orderEvents } from './application/events/order-events';
import { PaymentTransitionService } from './application/payment-transition.service';
import { OrdersEventsConsumer } from './infra/orders-events.consumer';
import { PaymentJobs } from './infra/payment.jobs';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  historyOf,
  paymentRow,
  payableBuyer,
  publishOrderCancelled,
  publishOrderPaid,
  publishOrderReserved,
  rows,
  seedPayment,
  type PaymentsTestApp,
} from './testing';

const SECOND = 1_000;

describe('Payments: order facts and order-driven compensation', () => {
  let t: PaymentsTestApp;
  let probe: JobsTestProbe;
  let jobs: PaymentJobs;
  let consumer: OrdersEventsConsumer;

  beforeAll(async () => {
    t = await createPaymentsApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
    jobs = t.app.get(PaymentJobs, { strict: false });
    consumer = t.app.get(OrdersEventsConsumer, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const copyOf = async (orderId: string) =>
    (
      await rows<{
        status: string;
        totalMinor: string | null;
        currency: string | null;
        orderVersion: number;
        updatedAt: Date;
      }>(
        t.app,
        `SELECT "status", "totalMinor", "currency", "orderVersion", "updatedAt" FROM "PayableOrder" WHERE "orderId" = :orderId`,
        { orderId },
      )
    )[0];
  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);

  describe('order facts in (AS-44)', () => {
    it('S13 AS-44: order.reserved creates the copy; a repeat changes nothing; stale and out-of-order messages are ignored', async () => {
      const userId = randomUUID();
      const { orderId, reservedUntil } = await publishOrderReserved(t.app, {
        userId,
        version: 1,
      });
      const first = (await copyOf(orderId))!;
      expect(first).toMatchObject({
        status: 'RESERVED',
        totalMinor: '2500',
        currency: 'EUR',
        orderVersion: 1,
      });
      expect(first.updatedAt).toEqual(t.clock.now());

      t.clock.advance(5 * SECOND);
      await publishOrderReserved(t.app, {
        userId,
        orderId,
        version: 1,
        reservedUntil,
      });
      expect(await copyOf(orderId)).toEqual(first); // delivered twice: no change at all

      await publishOrderCancelled(t.app, { orderId, userId, version: 3 });
      expect(await copyOf(orderId)).toMatchObject({
        status: 'CANCELLED',
        orderVersion: 3,
        totalMinor: '2500',
      });
      await publishOrderReserved(t.app, { userId, orderId, version: 1 }); // stale
      await publishOrderPaid(t.app, { orderId, userId, version: 2 }); // late
      expect(await copyOf(orderId)).toMatchObject({
        status: 'CANCELLED',
        orderVersion: 3,
      });
      expect(
        Number(
          (
            await rows<{ n: string }>(
              t.app,
              `SELECT count(*) AS n FROM "PayableOrder"`,
            )
          )[0].n,
        ),
      ).toBe(1);
    });

    it('S13 AS-44: five invalid payloads are dead-lettered without effect, other order types are ignored, and the next message is processed', async () => {
      const userId = randomUUID();
      const orderId = randomUUID();
      const valid = {
        orderId,
        userId,
        orderVersion: 1,
        totalMinor: 2_500,
        currency: 'EUR',
        shopIds: [],
        reservedUntil: new Date(
          t.clock.now().getTime() + 900_000,
        ).toISOString(),
      };
      const reserved = (payload: object, version = 1) => ({
        ...orderEvents().reserved.create(orderId, 1, valid),
        version,
        payload,
      });
      const bad = [
        reserved({ ...valid, orderId: undefined }),
        reserved({ ...valid, totalMinor: -5 }),
        reserved({ ...valid, orderId: 'not-a-uuid' }),
        reserved({ ...valid, currency: 'JPY' }),
        reserved(valid, 2), // a contract version this consumer does not understand
      ];
      const before =
        MetricsRegistry.value('payments_consumer_dead_lettered_total', {
          reason: 'invalid_payload',
        }) ?? 0;
      for (const envelope of bad)
        await expect(
          consumer.project([envelope as never]),
        ).rejects.toBeInstanceOf(PermanentError);
      expect(await copyOf(orderId)).toBeUndefined();
      expect(
        MetricsRegistry.value('payments_consumer_dead_lettered_total', {
          reason: 'invalid_payload',
        }),
      ).toBe(before + 5);

      // other order types are acknowledged and ignored
      await consumer.project([
        {
          ...orderEvents().reserved.create(orderId, 1, valid),
          type: 'order.refunded',
        } as never,
      ]);
      expect(await copyOf(orderId)).toBeUndefined();

      await consumer.project([
        orderEvents().reserved.create(orderId, 1, valid),
      ]);
      expect(await copyOf(orderId)).toMatchObject({ status: 'RESERVED' });
    });
  });

  describe('order cancelled (AS-47 to AS-49)', () => {
    /** A payment waiting for the customer at the provider: PENDING, attempted, customer action, intent pi_1. */
    const waitingForCustomer = async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.provider.script('create', {
        kind: 'ok',
        status: 'requires_action',
        overrides: { client_secret: 'cs_wait' },
      });
      await deliverCharge(t, id);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        requiresAction: true,
        providerRef: 'pi_1',
      });
      return { buyer, id };
    };
    const cancelOrder = (
      buyer: Awaited<ReturnType<typeof payableBuyer>>,
      version = 2,
    ) =>
      publishOrderCancelled(t.app, {
        orderId: buyer.order.orderId,
        userId: buyer.user.id,
        version,
      });

    it('S13 AS-47: cancelling the order cancels the provider intent once, the payment becomes CANCELLED(order_cancelled) with one payment_failed', async () => {
      const { buyer, id } = await waitingForCustomer();

      await cancelOrder(buyer);
      const scheduled = await probe.find('payments.cancel-intent', {
        paymentId: id,
      });
      expect(scheduled).toHaveLength(1);
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'PENDING' }); // the job does the provider call

      await jobs.cancelIntent({ paymentId: id });

      expect(t.provider.count('cancel')).toBe(1);
      expect(t.provider.calls.find((c) => c.op === 'cancel')).toMatchObject({
        subject: 'pi_1',
        idempotencyKey: `cancel:${id}`,
      });
      expect(t.provider.intents.get('pi_1')!.status).toBe('canceled'); // the customer can no longer confirm it
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
        failureCode: 'order_cancelled',
        clientSecret: null,
        requiresAction: false,
      });
      const failed = await eventsOf(id, 'payments.payment_failed');
      expect(failed).toHaveLength(1);
      expect(
        (
          failed[0].payload as {
            payload: { reasonCode: string; paymentRef: string };
          }
        ).payload,
      ).toMatchObject({
        reasonCode: 'order_cancelled',
        paymentRef: 'pi_1',
      });
    });

    it('S13 AS-47: a timed-out cancel is retried and the payment stays PENDING until the provider answers', async () => {
      const { buyer, id } = await waitingForCustomer();
      await cancelOrder(buyer);
      t.provider.script('cancel', { kind: 'timeout' });

      await expect(jobs.cancelIntent({ paymentId: id })).rejects.toThrow();
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        requiresAction: true,
      });

      await jobs.cancelIntent({ paymentId: id });
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
      });
      expect(t.provider.count('cancel')).toBe(2);
    });

    it('S13 AS-47: when the provider says the intent already succeeded the payment is COMPLETED', async () => {
      const { buyer, id } = await waitingForCustomer();
      await cancelOrder(buyer);
      t.provider.intents.get('pi_1')!.status = 'succeeded'; // the customer finished just in time

      await jobs.cancelIntent({ paymentId: id });

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        providerRef: 'pi_1',
      });
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
    });

    it('S13 AS-48: cancelling the order before any charge started cancels the payment without a provider call; the late charge command does nothing', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);

      await cancelOrder(buyer);

      expect(t.provider.calls).toHaveLength(0);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
        failureCode: 'order_cancelled',
        version: 2,
      });
      expect(await historyOf(t.app, id)).toContainEqual(
        expect.objectContaining({
          toStatus: 'CANCELLED',
          reason: 'order_cancelled',
          actor: 'system:order-events',
        }),
      );
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(1);

      await deliverCharge(t, id);
      expect(t.provider.calls).toHaveLength(0);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
        version: 2,
      });
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(1);
    });

    it('S13 AS-49: a running or unknown payment is not changed by the cancellation; when it completes the success is emitted and the unpayable-order counter moves', async () => {
      const user = await t.newUser();
      const running = await seedPayment(t.app, {
        userId: user.id,
        chargeAttemptedAt: t.clock.now(),
        chargeAttempts: 1,
      });
      const unknown = await seedPayment(t.app, {
        userId: user.id,
        status: 'UNKNOWN',
        version: 2,
        chargeAttemptedAt: t.clock.now(),
        unknownSince: t.clock.now(),
        nextResolveAt: t.clock.now(),
      });
      for (const p of [running, unknown])
        await publishOrderReserved(t.app, {
          userId: user.id,
          orderId: p.orderId,
        });

      for (const p of [running, unknown])
        await publishOrderCancelled(t.app, {
          orderId: p.orderId,
          userId: user.id,
          version: 2,
        });

      expect(await paymentRow(t.app, running.id)).toMatchObject({
        status: 'PENDING',
        version: 1,
      });
      expect(await paymentRow(t.app, unknown.id)).toMatchObject({
        status: 'UNKNOWN',
        version: 2,
      });
      expect(await probe.find('payments.cancel-intent')).toHaveLength(0);

      const before =
        MetricsRegistry.value('payments_completed_for_unpayable_order_total') ??
        0;
      const transitions = t.app.get(PaymentTransitionService, {
        strict: false,
      });
      await transitions.apply(
        running.id,
        { type: 'succeed' },
        'system:processor',
        { providerRef: 'pi_run' },
      );
      await transitions.apply(
        unknown.id,
        { type: 'succeed' },
        'system:resolver',
        { providerRef: 'pi_unk' },
      );

      expect(
        await eventsOf(running.id, 'payments.payment_succeeded'),
      ).toHaveLength(1);
      expect(
        await eventsOf(unknown.id, 'payments.payment_succeeded'),
      ).toHaveLength(1);
      expect(
        MetricsRegistry.value('payments_completed_for_unpayable_order_total'),
      ).toBe(before + 2);
    });
  });
});
