import {
  paymentEventSchemas,
  producedPaymentEventSchemas,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  getActiveTransaction,
  TransactionRunner,
} from '@app/infrastructure/context';
import { OutboxPublisherModule } from '@app/infrastructure/outbox/outbox-publisher.module';
import { OutboxPublisherService } from '@app/infrastructure/outbox/outbox-publisher.service';
import { createTopics, readTopic } from '@app/test/utils/kafka-test';
import { PaymentTransitionService } from './application/payment-transition.service';
import {
  LEDGER_POSTING,
  PAYMENT_HISTORY_REPOSITORY,
  PAYMENT_PROVIDER,
  type LedgerPosting,
  type PaymentHistoryRepository,
  type PaymentProvider,
} from './domain/ports';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  exec,
  historyOf,
  ledgerOf,
  paymentRow,
  payableBuyer,
  rows,
  seedPayment,
  type PaymentsTestApp,
} from './testing';

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('Payments: events, outbox atomicity and realtime', () => {
  let t: PaymentsTestApp;
  let relay: OutboxPublisherService;
  let transitions: PaymentTransitionService;

  beforeAll(async () => {
    await createTopics([{ topic: 'payments.events' }]);
    t = await createPaymentsApp({
      extraImports: [OutboxPublisherModule.register({ ticker: false })],
    });
    relay = t.app.get(OutboxPublisherService, { strict: false });
    transitions = t.app.get(PaymentTransitionService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const snapshot = async (paymentId: string) => ({
    payment: await paymentRow(t.app, paymentId),
    history: await historyOf(t.app, paymentId),
    ledger: await ledgerOf(t.app, paymentId),
    outbox: (await outboxRowsFor(t.app, paymentId)).map((r) => r.id),
  });
  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);

  describe('atomic through the outbox (AS-45)', () => {
    it('S13 AS-45: a failing ledger posting leaves status, history, journal and outbox exactly as they were', async () => {
      const user = await t.newUser();
      const { id } = await seedPayment(t.app, {
        userId: user.id,
        chargeAttemptedAt: t.clock.now(),
        chargeAttempts: 1,
      });
      const ledger = t.app.get<LedgerPosting>(LEDGER_POSTING, {
        strict: false,
      });
      t.patch(
        ledger,
        'recordCaptured',
        () =>
          (async () => {
            throw new Error('ledger down');
          }) as never,
      );
      const before = await snapshot(id);

      await expect(
        transitions.apply(id, { type: 'succeed' }, 'system:processor', {
          providerRef: 'pi_x',
        }),
      ).rejects.toThrow('ledger down');

      expect(await snapshot(id)).toEqual(before);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
      expect(t.realtime.published).toHaveLength(0);
    });

    it('S13 AS-45: a transaction aborted after the status update rolls the update back with everything else', async () => {
      const user = await t.newUser();
      const { id } = await seedPayment(t.app, {
        userId: user.id,
        chargeAttemptedAt: t.clock.now(),
        chargeAttempts: 1,
      });
      const history = t.app.get<PaymentHistoryRepository>(
        PAYMENT_HISTORY_REPOSITORY,
        { strict: false },
      );
      t.patch(
        history,
        'insert',
        () =>
          (async () => {
            throw new Error('aborted after the update');
          }) as never,
      );
      const before = await snapshot(id);

      await expect(
        transitions.apply(id, { type: 'succeed' }, 'system:processor', {
          providerRef: 'pi_x',
        }),
      ).rejects.toThrow('aborted');

      expect(await snapshot(id)).toEqual(before);
      expect((await paymentRow(t.app, id))!.status).toBe('PENDING');
    });

    it('S13 AS-45: after the commit the event waits in the outbox; once the relay runs it is on payments.events once, keyed by the payment, in the envelope, and a second run sends nothing', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      await deliverCharge(t, id);
      const pending = await eventsOf(id, 'payments.payment_succeeded');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        topic: 'payments.events',
        aggregateId: id,
      });
      expect((pending[0] as unknown as { status: string }).status).toBe(
        'pending',
      );

      // the relay is stopped: nothing is on the log yet
      const onLog = async () =>
        (await readTopic('payments.events')).filter((m) => m.key === id);
      expect(await onLog()).toHaveLength(0);

      await exec(t.app, `DELETE FROM "Outbox" WHERE "kind" = 'task'`); // the charge command goes to a queue, not this topic
      await relay.drain();
      await relay.drain(); // resumed twice: still once

      const messages = await onLog();
      expect(messages).toHaveLength(1);
      const envelope = messages[0].json<{
        eventId: string;
        type: string;
        version: number;
        occurredAt: string;
        aggregateId: string;
        aggregateType: string;
        payload: unknown;
      }>();
      expect(envelope).toMatchObject({
        type: 'payments.payment_succeeded',
        version: 1,
        aggregateId: id,
        aggregateType: 'payments',
      });
      expect(envelope.eventId).toEqual(expect.any(String));
      expect(new Date(envelope.occurredAt).toISOString()).toBe(
        envelope.occurredAt,
      );
      // the payload is what S10's consumer validates, plus the additive fields
      const payload = producedPaymentEventSchemas[
        'payments.payment_succeeded'
      ].parse(envelope.payload);
      expect(
        paymentEventSchemas['payments.payment_succeeded'].parse(
          envelope.payload,
        ),
      ).toEqual(payload);
      expect(payload).toMatchObject({
        paymentId: id,
        orderId: buyer.order.orderId,
        userId: buyer.user.id,
        paymentVersion: 2,
      });
    });

    it('S13 AS-45: every event kind validates with the shared contract schemas', async () => {
      const buyer = await payableBuyer(t);
      const ok = await acceptPayment(t, buyer);
      await deliverCharge(t, ok);
      const declined = await payableBuyer(t);
      const bad = await acceptPayment(t, declined);
      t.provider.script('create', {
        kind: 'card_error',
        code: 'card_declined',
      });
      await deliverCharge(t, bad);
      const cancelled = await payableBuyer(t);
      const gone = await acceptPayment(t, cancelled);
      await transitions.apply(
        gone,
        { type: 'cancel', reason: 'order_cancelled' },
        'system:order-events',
      );

      for (const [id, type] of [
        [ok, 'payments.payment_succeeded'],
        [bad, 'payments.payment_failed'],
        [gone, 'payments.payment_failed'],
      ] as const) {
        const [event] = await eventsOf(id, type);
        const payload = (event.payload as { payload: unknown }).payload;
        expect(
          producedPaymentEventSchemas[type].safeParse(payload).success,
        ).toBe(true);
        expect(paymentEventSchemas[type].safeParse(payload).success).toBe(true);
      }
    });
  });

  describe('no network call inside a transaction (AS-46)', () => {
    it('S13 AS-46: accepting a payment leaves only an outbox row: no queue message, no provider call', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);

      expect(t.queue.sent).toHaveLength(0);
      expect(t.provider.calls).toHaveLength(0);
      const rowsOf = await outboxRowsFor(t.app, id);
      expect(rowsOf).toHaveLength(1);
      expect(rowsOf[0]).toMatchObject({
        kind: 'task',
        topic: 'payments-charge',
      });
    });

    it('S13 AS-46: the provider is called with no transaction open, and a call from inside one is refused', async () => {
      const seen: boolean[] = [];
      t.provider.onCall = () => seen.push(getActiveTransaction() !== undefined);
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      await deliverCharge(t, id);
      expect(seen).toEqual([false]);

      const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER, {
        strict: false,
      });
      const runner = t.app.get(TransactionRunner);
      await expect(
        runner.run(() =>
          provider.createIntent({
            paymentId: id,
            orderId: buyer.order.orderId,
            amountMinor: 2_500,
            currency: 'EUR',
            paymentMethodToken: 'pm_x',
            referenceKey: buyer.order.orderId,
          }),
        ),
      ).rejects.toThrow(/not allowed inside a transaction/);
      expect(t.provider.calls).toHaveLength(1);
    });
  });

  describe('realtime (AS-61)', () => {
    it('S13 AS-61: each status change pushes one payment.status to the owner after the commit and to nobody else', async () => {
      const buyer = await payableBuyer(t);
      const other = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      await acceptPayment(t, other);
      t.realtime.published.length = 0;

      await deliverCharge(t, id);
      await settle();

      expect(t.realtime.published).toEqual([
        {
          topic: `user:${buyer.user.id}`,
          type: 'payment.status',
          data: {
            paymentId: id,
            orderId: buyer.order.orderId,
            status: 'COMPLETED',
            version: 2,
          },
        },
      ]);
    });

    it('S13 AS-61: with the hub down the transition and its events are unaffected; the failure is logged and counted', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.realtime.down = true;
      const before =
        MetricsRegistry.value('payments_realtime_publish_failed_total') ?? 0;

      await deliverCharge(t, id);
      await settle();

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        version: 2,
      });
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
      expect(
        MetricsRegistry.value('payments_realtime_publish_failed_total'),
      ).toBe(before + 1);
      expect(
        await rows(
          t.app,
          `SELECT 1 FROM "PaymentHistory" WHERE "paymentId" = :id AND "toStatus" = 'COMPLETED'`,
          { id },
        ),
      ).toHaveLength(1);
    });
  });
});
