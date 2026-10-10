import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  paymentSchema,
  producedPaymentEventSchemas,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { Sequelize } from 'sequelize-typescript';
import { PAYMENT_PROVIDER } from './domain/ports';
import { ChargeCommandWorker } from './infra/charge-command.worker';
import { StripePaymentProvider } from './infra/stripe-payment-provider.adapter';
import { CHARGE_QUEUE } from './application/payment-intent.service';
import { PaymentTransitionService } from './application/payment-transition.service';
import {
  acceptPayment,
  chargeCommandOf,
  createPaymentsApp,
  deliverCharge,
  exec,
  historyOf,
  ledgerOf,
  paymentRow,
  payableBuyer,
  type PaymentsTestApp,
} from './testing';

const settle = () => new Promise((r) => setTimeout(r, 120));

describe('Payments: charge processing and outcomes', () => {
  let t: PaymentsTestApp;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createPaymentsApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);
  const breaker = () =>
    (
      t.app.get(PAYMENT_PROVIDER, { strict: false }) as StripePaymentProvider
    ).breakerState('create_intent');

  it('S13 AS-15: success: one provider create with the order as reference, then COMPLETED with history, one balanced journal, one payment_succeeded, one push', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    t.realtime.published.length = 0;
    const stripeKey = t.app.get(ApiConfigService).get('stripe_secret_key');

    await deliverCharge(t, id);
    await settle();

    expect(t.provider.calls).toHaveLength(1);
    const [call] = t.provider.calls;
    expect(call).toMatchObject({
      op: 'create',
      subject: buyer.order.orderId,
      idempotencyKey: buyer.order.orderId,
    });
    expect(call.args).toMatchObject({
      amount: 2_500,
      paymentMethodId: 'pm_card_visa',
      metadata: { orderId: buyer.order.orderId, paymentId: id },
    });
    expect(
      String((call.args as { currency: string }).currency).toLowerCase(),
    ).toBe('eur');

    const row = (await paymentRow(t.app, id))!;
    expect(row).toMatchObject({
      status: 'COMPLETED',
      version: 2,
      providerRef: 'pi_1',
      chargeAttempts: 1,
      requiresAction: false,
      clientSecret: null,
      paymentMethodToken: null,
    });
    expect(await historyOf(t.app, id)).toEqual([
      expect.objectContaining({ version: 1, toStatus: 'PENDING' }),
      expect.objectContaining({
        version: 2,
        fromStatus: 'PENDING',
        toStatus: 'COMPLETED',
        actor: 'system:processor',
      }),
    ]);
    const lines = await ledgerOf(t.app, id);
    expect(lines).toHaveLength(3);
    expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBe(0);

    const events = await eventsOf(id, 'payments.payment_succeeded');
    expect(events).toHaveLength(1);
    expect(events[0].topic).toBe('payments.events');
    expect(events[0].aggregateId).toBe(id);
    const payload = (events[0].payload as { payload: unknown }).payload;
    expect(
      producedPaymentEventSchemas['payments.payment_succeeded'].parse(payload),
    ).toMatchObject({
      paymentId: id,
      paymentRef: 'pi_1',
      orderId: buyer.order.orderId,
      userId: buyer.user.id,
      amountMinor: 2_500,
      currency: 'EUR',
      paymentVersion: 2,
    });
    expect(JSON.stringify(events[0])).not.toContain('pm_card_visa');
    expect(JSON.stringify(events[0])).not.toContain(stripeKey);
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

  it('S13 AS-21: twenty reads of a completed payment return the same paymentSchema and change nothing', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    await deliverCharge(t, id);
    await settle();
    const before = {
      row: await paymentRow(t.app, id),
      history: await historyOf(t.app, id),
      outbox: (await outboxRowsFor(t.app, id)).length,
      calls: t.provider.calls.length,
    };

    for (let i = 0; i < 20; i++) {
      const res = await t.as(buyer.user).get(`/api/payments/${id}`);
      expect(res.status).toBe(200);
      const view = paymentSchema.parse(res.body);
      expect(view).toMatchObject({
        id,
        orderId: buyer.order.orderId,
        status: 'COMPLETED',
        amountMinor: 2_500,
        currency: 'EUR',
        failureCode: null,
        requiresAction: false,
        clientSecret: null,
        version: 2,
      });
    }

    expect(await paymentRow(t.app, id)).toEqual(before.row);
    expect(await historyOf(t.app, id)).toEqual(before.history);
    expect((await outboxRowsFor(t.app, id)).length).toBe(before.outbox);
    expect(t.provider.calls.length).toBe(before.calls);
  });

  it('S13 AS-16: a definite decline fails the payment with the card code, books nothing, publishes one failure, is not retried and does not trip the breaker', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    t.provider.script('create', {
      kind: 'card_error',
      code: 'card_declined',
      declineCode: 'generic_decline',
    });

    await deliverCharge(t, id);

    expect(await paymentRow(t.app, id)).toMatchObject({
      status: 'FAILED',
      version: 2,
      failureCode: 'card_declined',
      paymentMethodToken: null,
    });
    expect(await ledgerOf(t.app, id)).toHaveLength(0);
    const failed = await eventsOf(id, 'payments.payment_failed');
    expect(failed).toHaveLength(1);
    expect(
      producedPaymentEventSchemas['payments.payment_failed'].parse(
        (failed[0].payload as { payload: unknown }).payload,
      ),
    ).toMatchObject({
      reasonCode: 'card_declined',
      paymentRef: null,
      paymentVersion: 2,
    });
    expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
    expect(await probe.find('payments.charge', { paymentId: id })).toHaveLength(
      0,
    );
    await deliverCharge(t, id); // a repeat of the command: nothing happens
    expect(t.provider.count('create')).toBe(1);
    expect(breaker()).toBe('CLOSED');
    expect(
      MetricsRegistry.value('circuit_breaker_open', {
        breaker: 'create_intent',
      }),
    ).toBe(0);
  });

  it('S13 AS-17: customer action required: the payment stays PENDING with the client secret kept for the owner; a later success clears it', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    t.provider.script('create', {
      kind: 'ok',
      status: 'requires_action',
      overrides: { client_secret: 'pi_secret_3ds' },
    });

    await deliverCharge(t, id);

    expect(await paymentRow(t.app, id)).toMatchObject({
      status: 'PENDING',
      version: 1,
      requiresAction: true,
      clientSecret: 'pi_secret_3ds',
      providerRef: 'pi_1',
      chargeAttempts: 1,
    });
    expect(await historyOf(t.app, id)).toHaveLength(1);
    expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
    expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(0);
    expect(JSON.stringify(await outboxRowsFor(t.app, id))).not.toContain(
      'pi_secret_3ds',
    );

    await t.app
      .get(PaymentTransitionService, { strict: false })
      .apply(id, { type: 'succeed' }, 'system:refresh', {
        providerRef: 'pi_1',
      });
    expect(await paymentRow(t.app, id)).toMatchObject({
      status: 'COMPLETED',
      requiresAction: false,
      clientSecret: null,
    });
  });

  it('S13 AS-18: a request the provider refuses (400, 401) fails the payment with provider_rejected, logs the provider request id without any secret, and leaves the breaker alone', async () => {
    const stripeKey = t.app.get(ApiConfigService).get('stripe_secret_key');
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    for (const statusCode of [400, 401]) {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer, 'pm_secret_token_sentinel');
      t.provider.script('create', {
        kind: 'http',
        statusCode,
        requestId: `req_${statusCode}`,
      });

      await deliverCharge(t, id);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_rejected',
      });
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(1);
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        `req_${statusCode}`,
      );
    }
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain(stripeKey);
    expect(logged).not.toContain('pm_secret_token_sentinel');
    expect(
      MetricsRegistry.value('payments_provider_calls_total', {
        operation: 'create_intent',
        outcome: 'rejected',
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(breaker()).toBe('CLOSED');
    error.mockRestore();
  });

  it('S13 AS-19: an order that stopped being payable before the charge starts cancels the payment without calling the provider', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    // The cancellation fact reached the copy but its own compensation (AS-48) has not run yet: the charge must still refuse.
    await exec(
      t.app,
      `UPDATE "PayableOrder" SET "status" = 'CANCELLED', "orderVersion" = 2 WHERE "orderId" = :orderId`,
      {
        orderId: buyer.order.orderId,
      },
    );

    await deliverCharge(t, id);

    expect(t.provider.calls).toHaveLength(0);
    expect(await paymentRow(t.app, id)).toMatchObject({
      status: 'CANCELLED',
      failureCode: 'order_not_payable',
      version: 2,
      chargeAttemptedAt: null,
    });
    const failed = await eventsOf(id, 'payments.payment_failed');
    expect(failed).toHaveLength(1);
    expect(
      (failed[0].payload as { payload: { reasonCode: string } }).payload
        .reasonCode,
    ).toBe('order_not_payable');
  });

  describe('the charge command (AS-20)', () => {
    it('S13 AS-20: delivered twice in a row and twice at once gives one provider create, one transition and one event', async () => {
      const first = await payableBuyer(t);
      const a = await acceptPayment(t, first);
      await deliverCharge(t, a);
      await deliverCharge(t, a);
      expect(t.provider.count('create')).toBe(1);
      expect((await paymentRow(t.app, a))!.version).toBe(2);
      expect(await eventsOf(a, 'payments.payment_succeeded')).toHaveLength(1);

      const second = await payableBuyer(t);
      const b = await acceptPayment(t, second);
      await Promise.all([deliverCharge(t, b), deliverCharge(t, b)]);
      await settle();
      expect(t.provider.count('create')).toBe(2);
      expect(await paymentRow(t.app, b)).toMatchObject({
        status: 'COMPLETED',
        version: 2,
      });
      expect(await eventsOf(b, 'payments.payment_succeeded')).toHaveLength(1);
      expect(await historyOf(t.app, b)).toHaveLength(2);
    });

    it('S13 AS-20: invalid payloads are dead-lettered without effect and the next command is processed', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      const body = await chargeCommandOf(t, id);
      const bad = [
        {},
        { paymentId: 'not-a-uuid', attempt: 0 },
        { paymentId: randomUUID() },
        { paymentId: randomUUID(), attempt: -1 },
      ];
      for (const b of bad) await t.queue.enqueue(CHARGE_QUEUE, b);
      await t.queue.enqueue(CHARGE_QUEUE, body);

      await t.queue.drain(CHARGE_QUEUE);

      expect(t.queue.deadLettered).toHaveLength(4);
      expect(
        t.queue.deadLettered.every((d) => d.reason === 'SCHEMA_INVALID'),
      ).toBe(true);
      expect(t.provider.count('create')).toBe(1);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
      });
      // a body that only looks valid (unknown payment) does nothing
      await t.app
        .get(ChargeCommandWorker, { strict: false })
        .handle({ body: { paymentId: randomUUID(), attempt: 0 } });
      expect(t.provider.count('create')).toBe(1);
    });
  });

  describe("the provider's answer is not trusted (AS-22)", () => {
    it.each([
      ['amount', { amount: 999 }],
      ['currency', { currency: 'usd' }],
      ['status', { status: undefined }],
      ['orderId', { metadata: { orderId: 'someone-else' } }],
    ])(
      'S13 AS-22: a wrong %s makes the payment UNKNOWN(provider_response_invalid), books and publishes nothing, logs it and counts the field',
      async (field, overrides) => {
        const buyer = await payableBuyer(t);
        const id = await acceptPayment(t, buyer);
        const before =
          MetricsRegistry.value('payments_provider_mismatch_total', {
            field,
          }) ?? 0;
        const error = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation();
        t.provider.script('create', { kind: 'ok', overrides });

        await deliverCharge(t, id);

        expect(await paymentRow(t.app, id)).toMatchObject({
          status: 'UNKNOWN',
          version: 2,
        });
        expect(await historyOf(t.app, id)).toEqual([
          expect.objectContaining({ version: 1 }),
          expect.objectContaining({
            version: 2,
            toStatus: 'UNKNOWN',
            reason: 'provider_response_invalid',
          }),
        ]);
        expect(await ledgerOf(t.app, id)).toHaveLength(0);
        expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(
          0,
        );
        expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(0);
        expect(
          MetricsRegistry.value('payments_provider_mismatch_total', { field }),
        ).toBe(before + 1);
        expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
          field,
        );
        error.mockRestore();
      },
    );
  });
});
