import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { producedPaymentEventSchemas } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { PaymentTransitionService } from './application/payment-transition.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './domain/ports';
import { PaymentJobs } from './infra/payment.jobs';
import { RefundRequestWorker } from './infra/refund-request.worker';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  historyOf,
  ledgerOf,
  paymentRow,
  payableBuyer,
  type PayableBuyer,
  type PaymentsTestApp,
} from './testing';

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DLQ = 'orders-refund-requested-dlq';

describe('Payments: refund commands', () => {
  let t: PaymentsTestApp;
  let probe: JobsTestProbe;
  let worker: RefundRequestWorker;
  let jobs: PaymentJobs;
  let provider: PaymentProvider;

  beforeAll(async () => {
    t = await createPaymentsApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
    worker = t.app.get(RefundRequestWorker, { strict: false });
    jobs = t.app.get(PaymentJobs, { strict: false });
    provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const message = (
    buyer: PayableBuyer,
    over: Record<string, unknown> = {},
  ) => ({
    orderId: buyer.order.orderId,
    paymentRef: 'pi_1',
    amountMinor: 2_500,
    currency: 'EUR',
    reason: 'order_cancelled',
    ...over,
  });
  const send = (body: unknown) => worker.handle({ body });
  const counter = (name: string, labels: Record<string, string>) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);
  const refundJobs = (paymentId: string) =>
    probe.find('payments.refund', { paymentId });
  /** A buyer whose payment is COMPLETED at provider reference pi_1. */
  const completed = async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    await deliverCharge(t, id);
    const row = (await paymentRow(t.app, id))!;
    expect(row).toMatchObject({
      status: 'COMPLETED',
      providerRef: expect.stringMatching(/^pi_/),
    });
    return { buyer, id, ref: row.providerRef! };
  };
  const runRefundJob = (id: string) => jobs.refund({ paymentId: id });

  describe('a completed payment (AS-50, AS-51)', () => {
    it('S13 AS-50: the command moves the payment to REFUND_PENDING, one provider refund follows, then REFUNDED with one reversing journal, one event and one push', async () => {
      const { buyer, id } = await completed();
      t.realtime.published.length = 0;

      await send(message(buyer));

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUND_PENDING',
        version: 3,
      });
      expect(await historyOf(t.app, id)).toContainEqual(
        expect.objectContaining({
          version: 3,
          fromStatus: 'COMPLETED',
          toStatus: 'REFUND_PENDING',
          reason: 'order_cancelled',
        }),
      );
      expect(await refundJobs(id)).toHaveLength(1);
      expect(t.provider.count('refund')).toBe(0);

      await runRefundJob(id);
      await new Promise((r) => setTimeout(r, 150));

      expect(t.provider.count('refund')).toBe(1);
      expect(t.provider.calls.find((c) => c.op === 'refund')).toMatchObject({
        subject: 'pi_1',
        idempotencyKey: `refund:${id}`,
        timeoutMs: 8_000,
      });
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUNDED',
        version: 4,
      });
      const lines = await ledgerOf(t.app, id);
      expect(lines.filter((l) => l.kind === 'REFUND')).toHaveLength(3);
      for (const kind of ['SALE', 'REFUND'])
        expect(
          lines
            .filter((l) => l.kind === kind)
            .reduce((s, l) => s + Number(l.amount), 0),
        ).toBe(0);
      expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBe(0);
      expect(
        Object.fromEntries(
          lines.reduce(
            (m, l) =>
              m.set(l.accountId, (m.get(l.accountId) ?? 0) + Number(l.amount)),
            new Map<string, number>(),
          ),
        ),
      ).toEqual({
        PROVIDER_FUNDS: 0,
        MARKETPLACE_CLEARING: 0,
        PLATFORM_FEES: 0,
      });
      const events = await eventsOf(id, 'payments.payment_refunded');
      expect(events).toHaveLength(1);
      expect(
        producedPaymentEventSchemas['payments.payment_refunded'].parse(
          (events[0].payload as { payload: unknown }).payload,
        ),
      ).toMatchObject({
        paymentId: id,
        paymentRef: 'pi_1',
        orderId: buyer.order.orderId,
        userId: buyer.user.id,
        amountMinor: 2_500,
        currency: 'EUR',
        paymentVersion: 4,
      });
      expect(
        t.realtime.published.filter(
          (p) => (p.data as { status: string }).status === 'REFUNDED',
        ),
      ).toHaveLength(1);
    });

    it('S13 AS-51: five at once and a later repeat give one transition, one provider refund, one journal and one event', async () => {
      const { buyer, id } = await completed();

      await Promise.all(Array.from({ length: 5 }, () => send(message(buyer))));
      expect(await refundJobs(id)).toHaveLength(1);
      expect(
        (await historyOf(t.app, id)).filter(
          (h) => h.toStatus === 'REFUND_PENDING',
        ),
      ).toHaveLength(1);

      await runRefundJob(id);
      await runRefundJob(id); // a second run of the job finds nothing left to do
      await send(message(buyer)); // a later repeat meets REFUNDED

      expect(t.provider.count('refund')).toBe(1);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUNDED',
        version: 4,
      });
      expect(
        (await ledgerOf(t.app, id)).filter((l) => l.kind === 'REFUND'),
      ).toHaveLength(3);
      expect(await eventsOf(id, 'payments.payment_refunded')).toHaveLength(1);
      expect(await refundJobs(id)).toHaveLength(1);
    });
  });

  describe('a payment that is not settled yet (AS-52)', () => {
    const unknown = async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.provider.script('create', { kind: 'timeout', applied: true });
      await deliverCharge(t, id);
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
      return { buyer, id };
    };

    it('S13 AS-52: an UNKNOWN payment is not refunded yet: nothing changes and the wait goes on; once it is COMPLETED the next run refunds it', async () => {
      const { buyer, id } = await unknown();
      const before = await paymentRow(t.app, id);

      await send(message(buyer, { paymentRef: 'pi_1' }));
      await runRefundJob(id);
      t.clock.advance(5 * MINUTE);
      await runRefundJob(id);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'UNKNOWN',
        version: before!.version,
      });
      expect(t.provider.count('refund')).toBe(0);
      expect((await refundJobs(id)).length).toBeGreaterThanOrEqual(2); // the wait goes on with new runs
      expect((await paymentRow(t.app, id))!.refundRequestedAt).not.toBeNull();

      await t.app
        .get(PaymentTransitionService, { strict: false })
        .apply(id, { type: 'succeed' }, 'system:resolver', {
          providerRef: 'pi_1',
        });
      await runRefundJob(id);

      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'REFUNDED' });
      expect(t.provider.count('refund')).toBe(1);
    });

    it('S13 AS-52: a payment that ended FAILED or CANCELLED has nothing to refund', async () => {
      const failed = await payableBuyer(t);
      const failedId = await acceptPayment(t, failed);
      t.provider.script('create', {
        kind: 'card_error',
        code: 'card_declined',
      });
      await deliverCharge(t, failedId);
      const before = counter('payments_refund_requests_total', {
        result: 'nothing_to_refund',
      });

      await send(message(failed));
      expect(await paymentRow(t.app, failedId)).toMatchObject({
        status: 'FAILED',
      });
      expect(
        counter('payments_refund_requests_total', {
          result: 'nothing_to_refund',
        }),
      ).toBe(before + 1);

      // UNKNOWN that later fails: the waiting run ends as "nothing to refund"
      const { buyer, id } = await unknown();
      await send(message(buyer));
      await t.app
        .get(PaymentTransitionService, { strict: false })
        .apply(
          id,
          { type: 'fail', code: 'no_provider_record' },
          'system:resolver',
        );
      await runRefundJob(id);
      expect(
        counter('payments_refund_requests_total', {
          result: 'nothing_to_refund',
        }),
      ).toBe(before + 2);
      expect(t.provider.count('refund')).toBe(0);
    });

    it('S13 AS-52: after 24 hours unsettled the wait is dead-lettered with an alert', async () => {
      const { buyer, id } = await unknown();
      await send(message(buyer));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const before = counter('payments_consumer_dead_lettered_total', {
        reason: 'refund_wait_expired',
      });

      t.clock.advance(24 * HOUR + SECOND);
      await runRefundJob(id);

      expect(
        counter('payments_consumer_dead_lettered_total', {
          reason: 'refund_wait_expired',
        }),
      ).toBe(before + 1);
      expect(error).toHaveBeenCalled();
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
      const waiting = (await refundJobs(id)).length;
      await runRefundJob(id);
      expect((await refundJobs(id)).length).toBe(waiting); // no further wait is scheduled
      error.mockRestore();
    });

    it('S13 AS-52: a payment whose charge has not started is cancelled, as when the order is cancelled', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);

      await send(message(buyer));

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'CANCELLED',
        failureCode: 'order_cancelled',
      });
      expect(t.provider.calls).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(1);
    });
  });

  describe('requests that do not match (AS-53)', () => {
    it('S13 AS-53: each mismatch or invalid class is dead-lettered with its reason and no effect, and the next message is processed', async () => {
      const { buyer, id } = await completed();
      const reasons = async (reason: string) =>
        counter('payments_consumer_dead_lettered_total', { reason });
      const cases: Array<[string, unknown]> = [
        ['refund_amount_mismatch', message(buyer, { amountMinor: 2_499 })],
        ['refund_currency_mismatch', message(buyer, { currency: 'USD' })],
        ['refund_ref_mismatch', message(buyer, { paymentRef: 'pi_other' })],
        ['payment_not_found', message(buyer, { orderId: randomUUID() })],
        ['unsupported_reason', message(buyer, { reason: 'changed_my_mind' })],
        ['invalid_payload', { ...message(buyer), orderId: undefined }],
        ['invalid_payload', message(buyer, { amountMinor: -1 })],
        ['invalid_payload', message(buyer, { orderId: 'not-a-uuid' })],
      ];
      for (const [reason, body] of cases) {
        const before = await reasons(reason);
        await send(body);
        expect(await reasons(reason)).toBe(before + 1);
      }

      expect(t.queue.sent.filter((m) => m.queue === DLQ)).toHaveLength(
        cases.length,
      );
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        version: 2,
      });
      expect(await refundJobs(id)).toHaveLength(0);

      await send(message(buyer)); // the next message is processed
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
    });
  });

  describe('the provider fails while refunding (AS-54)', () => {
    /** A payment in REFUND_PENDING, the refund job not yet run. */
    const refundPending = async () => {
      const c = await completed();
      await send(message(c.buyer, { paymentRef: c.ref }));
      return c;
    };

    it('S13 AS-54: a timed-out refund is retried after a lookup; a refund the provider already made counts without a second call', async () => {
      const { id } = await refundPending();
      t.provider.script('refund', { kind: 'timeout', applied: true }); // the provider refunded, the answer was lost

      await runRefundJob(id);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
      const row = (await paymentRow(t.app, id))!;
      expect(row.refundNextAt!.getTime()).toBeGreaterThanOrEqual(
        t.clock.now().getTime(),
      );
      expect(
        row.refundNextAt!.getTime() - t.clock.now().getTime(),
      ).toBeLessThanOrEqual(15 * MINUTE);
      expect(await refundJobs(id)).toHaveLength(2);
      expect(t.provider.count('refund')).toBe(1);

      t.clock.advance(15 * MINUTE);
      await runRefundJob(id);

      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'REFUNDED' });
      expect(t.provider.count('refund')).toBe(1); // found by lookup, never sent again
      expect(t.provider.count('refunds')).toBe(2);
    });

    it('S13 AS-54: "already refunded" counts as done', async () => {
      const { id } = await refundPending();
      t.provider.script('refund', {
        kind: 'http',
        statusCode: 400,
        code: 'charge_already_refunded',
      });

      await runRefundJob(id);

      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'REFUNDED' });
    });

    it('S13 AS-54: a hard refusal and the 24-hour limit leave REFUND_PENDING with an error, the stuck counter and the age gauge', async () => {
      const refused = await refundPending();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const stuck = counter('payments_refund_stuck_total', {});
      t.provider.script('refund', { kind: 'http', statusCode: 403 });
      t.clock.advance(2 * HOUR);

      await runRefundJob(refused.id);

      expect(await paymentRow(t.app, refused.id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
      expect(counter('payments_refund_stuck_total', {})).toBe(stuck + 1);
      expect(error).toHaveBeenCalled();
      expect(
        MetricsRegistry.value('payments_refund_pending_oldest_age_seconds'),
      ).toBeGreaterThanOrEqual(2 * 3600);

      const slow = await refundPending();
      t.provider.scriptRepeat('refund', { kind: 'timeout' }, 5);
      await runRefundJob(slow.id);
      t.clock.advance(24 * HOUR + SECOND);
      await runRefundJob(slow.id);
      expect(await paymentRow(t.app, slow.id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
      expect(counter('payments_refund_stuck_total', {})).toBe(stuck + 2);
      error.mockRestore();
    });

    it('S13 AS-54: with the refund breaker open the retry is scheduled later and the provider is not called', async () => {
      const { id } = await refundPending();
      t.provider.scriptRepeat('refunds', { kind: 'http', statusCode: 503 }, 10);
      for (let i = 0; i < 10; i++) await provider.findRefunds('pi_x');
      expect(
        MetricsRegistry.value('circuit_breaker_open', { breaker: 'refund' }),
      ).toBe(1);
      const calls = t.provider.calls.length;

      await runRefundJob(id);

      expect(t.provider.calls.length).toBe(calls);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'REFUND_PENDING',
      });
      expect(await refundJobs(id)).toHaveLength(2);
    });
  });
});
