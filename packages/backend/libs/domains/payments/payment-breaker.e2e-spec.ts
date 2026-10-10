import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { PaymentChargeService } from './application/payment-charge.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './domain/ports';
import { PaymentJobs } from './infra/payment.jobs';
import {
  acceptPayment,
  createGate,
  createPaymentsApp,
  deliverCharge,
  paymentRow,
  payableBuyer,
  rows,
  type PaymentsTestApp,
} from './testing';

const SECOND = 1_000;
const MINUTE = 60_000;

describe('Payments: provider circuit breaker, timeouts and degradation', () => {
  let t: PaymentsTestApp;
  let probe: JobsTestProbe;
  let jobs: PaymentJobs;
  let charges: PaymentChargeService;
  let provider: PaymentProvider;

  beforeAll(async () => {
    t = await createPaymentsApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
    jobs = t.app.get(PaymentJobs, { strict: false });
    charges = t.app.get(PaymentChargeService, { strict: false });
    provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const gauge = (breaker = 'create_intent') =>
    MetricsRegistry.value('circuit_breaker_open', { breaker });
  /** Accepted payments (PENDING, command not yet delivered), one buyer each. */
  const pending = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++)
      ids.push(await acceptPayment(t, await payableBuyer(t)));
    return ids;
  };
  /** Ten charges answered 503: the create breaker opens. */
  const openCreateBreaker = async () => {
    t.provider.scriptRepeat('create', { kind: 'http', statusCode: 503 }, 10);
    for (const id of await pending(10)) await deliverCharge(t, id);
    expect(gauge()).toBe(1);
  };
  const intentsFor = (orderId: string) =>
    [...t.provider.intents.values()].filter(
      (i) => i.metadata?.orderId === orderId,
    );

  it('S13 AS-31: ten 503s open the breaker: ten UNKNOWN payments, the gauge at 1, then a charge that never reaches the provider stays PENDING with a retry scheduled and the accept route still answers', async () => {
    t.provider.scriptRepeat('create', { kind: 'http', statusCode: 503 }, 10);
    const ids = await pending(10);
    for (const id of ids) await deliverCharge(t, id);
    for (const id of ids)
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
    expect(gauge()).toBe(1);
    expect(t.provider.count('create')).toBe(10);

    const [eleventh] = await pending(1);
    await deliverCharge(t, eleventh);

    expect(t.provider.count('create')).toBe(10);
    expect(await paymentRow(t.app, eleventh)).toMatchObject({
      status: 'PENDING',
      version: 1,
      chargeAttemptedAt: null,
      chargeAttempts: 1,
    });
    const retries = await probe.find('payments.charge', {
      paymentId: eleventh,
    });
    expect(retries).toHaveLength(1);
    expect(retries[0].payload).toEqual({ paymentId: eleventh, attempt: 1 });
    const buyer = await payableBuyer(t);
    const accepted = await t
      .as(buyer.user)
      .post('/api/payments/intents')
      .set('Idempotency-Key', 'key-while-open-0001')
      .send({ orderId: buyer.order.orderId, paymentMethodId: 'pm_x' });
    expect(accepted.status).toBe(202);
  });

  it('S13 AS-32: after 30 s one probe goes through while concurrent calls are refused without reaching the provider; success closes the breaker', async () => {
    const [a, b, c] = await pending(3);
    await openCreateBreaker();
    t.clock.advance(30 * SECOND);
    const before = t.provider.count('create');
    const gate = createGate();
    t.provider.script('create', { kind: 'hang', gate });

    const probeCall = deliverCharge(t, a);
    await gate.reached;
    await deliverCharge(t, b);
    await deliverCharge(t, c);
    expect(t.provider.count('create')).toBe(before + 1);
    for (const id of [b, c])
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        chargeAttemptedAt: null,
      });

    gate.open();
    await probeCall;
    expect(await paymentRow(t.app, a)).toMatchObject({ status: 'COMPLETED' });
    expect(gauge()).toBe(0);
    await deliverCharge(t, b);
    expect(await paymentRow(t.app, b)).toMatchObject({ status: 'COMPLETED' });
  });

  it('S13 AS-32: a failed probe reopens the breaker for another 30 s', async () => {
    const [a, b, c] = await pending(3);
    await openCreateBreaker();
    t.clock.advance(30 * SECOND);
    t.provider.script('create', { kind: 'http', statusCode: 503 });
    await deliverCharge(t, a); // the probe fails
    expect(gauge()).toBe(1);
    const afterProbe = t.provider.count('create');

    t.clock.advance(29 * SECOND);
    await deliverCharge(t, b);
    expect(t.provider.count('create')).toBe(afterProbe);

    t.clock.advance(1 * SECOND);
    await deliverCharge(t, c);
    expect(t.provider.count('create')).toBe(afterProbe + 1);
  });

  it('S13 AS-32: with the provider down for a minute the provider sees at most two calls', async () => {
    await openCreateBreaker();
    const attempts = await pending(13);
    const opened = t.provider.count('create');
    t.provider.scriptRepeat('create', { kind: 'http', statusCode: 503 }, 20);
    for (const id of attempts) {
      await deliverCharge(t, id);
      t.clock.advance(5 * SECOND);
    }
    expect(t.provider.count('create') - opened).toBeLessThanOrEqual(2);
  });

  it('S13 AS-33: fifty declines never trip the breaker; ten successful calls that each take 6 s do', async () => {
    t.provider.scriptRepeat(
      'create',
      {
        kind: 'card_error',
        code: 'card_declined',
        declineCode: 'generic_decline',
      },
      50,
    );
    for (const id of await pending(50)) await deliverCharge(t, id);
    expect(gauge()).toBe(0);
    const [next] = await pending(1);
    await deliverCharge(t, next);
    expect(t.provider.count('create')).toBe(51);
    expect(await paymentRow(t.app, next)).toMatchObject({
      status: 'COMPLETED',
    });

    const slowOnes = await pending(10);
    t.clock.advance(11 * SECOND); // the fifty-one earlier answers leave the 10 s window
    const gate = createGate();
    t.provider.scriptRepeat('create', { kind: 'hang', gate }, 10);
    const started = t.provider.count('create');
    const running = slowOnes.map((id) => deliverCharge(t, id));
    while (t.provider.count('create') < started + 10)
      await new Promise((r) => setTimeout(r, 10)); // all ten are in flight
    t.clock.advance(6 * SECOND);
    gate.open();
    await Promise.all(running);
    expect(gauge()).toBe(1);
  });

  describe('the charge retry (AS-34, AS-35)', () => {
    it('S13 AS-34: a retry is scheduled with full jitter; when the provider recovers the payment completes with one create', async () => {
      await openCreateBreaker();
      const [id] = await pending(1);
      await deliverCharge(t, id);

      const first = await probe.find('payments.charge', { paymentId: id });
      expect(first).toHaveLength(1);
      const delay1 = first[0].runAt.getTime() - t.clock.now().getTime();
      expect(delay1).toBeGreaterThanOrEqual(0);
      expect(delay1).toBeLessThanOrEqual(2 * SECOND);

      await jobs.charge({ paymentId: id, attempt: 1 }); // still open
      const second = await probe.find('payments.charge', { paymentId: id });
      expect(second).toHaveLength(2);
      const delay2 = second[1].runAt.getTime() - t.clock.now().getTime();
      expect(delay2).toBeLessThanOrEqual(4 * SECOND);
      expect(t.provider.count('create')).toBe(10);

      t.clock.advance(31 * SECOND); // the provider is back
      await jobs.charge({ paymentId: id, attempt: 2 });

      const row = (await paymentRow(t.app, id))!;
      expect(row).toMatchObject({ status: 'COMPLETED', chargeAttempts: 3 });
      expect(intentsFor(row.orderId)).toHaveLength(1);
    });

    it('S13 AS-34: six attempts that never reach the provider end FAILED(provider_unavailable) with no create and one event', async () => {
      await openCreateBreaker();
      const [id] = await pending(1);
      for (let attempt = 0; attempt < 6; attempt++)
        await charges.charge(id, attempt);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_unavailable',
        chargeAttempts: 6,
      });
      expect(t.provider.count('create')).toBe(10);
      const events = (await outboxRowsFor(t.app, id)).filter(
        (r) => r.type === 'payments.payment_failed',
      );
      expect(events).toHaveLength(1);
      expect(
        (events[0].payload as { payload: { reasonCode: string } }).payload
          .reasonCode,
      ).toBe('provider_unavailable');
      await charges.charge(id, 6); // nothing more happens
      expect((await paymentRow(t.app, id))!.chargeAttempts).toBe(6);
    });

    it('S13 AS-34: ten minutes after creation the next attempt that does not reach the provider is the last', async () => {
      const [id] = await pending(1);
      t.provider.scriptRepeat('create', { kind: 'connect_refused' }, 4);
      await charges.charge(id, 0);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        chargeAttempts: 1,
      });

      t.clock.advance(10 * MINUTE - 2 * SECOND);
      await charges.charge(id, 1);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        chargeAttempts: 2,
      });

      t.clock.advance(3 * SECOND);
      await charges.charge(id, 2);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_unavailable',
        chargeAttempts: 3,
      });
      expect(t.provider.intents.size).toBe(0);
    });

    it('S13 AS-35: the provider client does no retries of its own and the charge never exceeds six attempts', async () => {
      const stripe = t.app.get(StripeService, { strict: false }) as unknown as {
        stripe: { getMaxNetworkRetries(): number };
      };
      expect(stripe.stripe.getMaxNetworkRetries()).toBe(0);

      const [id] = await pending(1);
      t.provider.scriptRepeat('create', { kind: 'connect_refused' }, 20);
      for (let attempt = 0; attempt < 12; attempt++)
        await charges.charge(id, attempt);
      expect(t.provider.count('create')).toBeLessThanOrEqual(6);
      expect((await paymentRow(t.app, id))!.chargeAttempts).toBe(6);
    });
  });

  it('S13 AS-36: a hung provider call is bounded per operation (8 s create, 4 s lookup and cancel, 2 s refresh) and holds no transaction while it waits; other requests are not slowed', async () => {
    const [id, other] = await pending(2);
    const gate = createGate();
    t.provider.script('create', { kind: 'hang', gate });
    const hung = deliverCharge(t, id);
    await gate.reached;

    const idle = await rows<{ n: string }>(
      t.app,
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
    );
    expect(Number(idle[0].n)).toBe(0);
    const buyer = await payableBuyer(t);
    const started = performance.now();
    const meanwhile = await t
      .as(buyer.user)
      .post('/api/payments/intents')
      .set('Idempotency-Key', 'key-meanwhile-0001')
      .send({ orderId: buyer.order.orderId, paymentMethodId: 'pm_x' });
    expect(meanwhile.status).toBe(202);
    expect(performance.now() - started).toBeLessThan(300);
    await deliverCharge(t, other);
    expect(await paymentRow(t.app, other)).toMatchObject({
      status: 'COMPLETED',
    });
    gate.open();
    await hung;

    await provider.findIntentByReference('order-x');
    await provider.retrieveIntent('pi_x');
    await provider.cancelIntent('pi_x', 'cancel:x');
    const limits = Object.fromEntries(
      t.provider.calls.map((c) => [c.op, c.timeoutMs]),
    );
    expect(limits).toMatchObject({
      create: 8_000,
      find: 4_000,
      retrieve: 2_000,
      cancel: 4_000,
    });
  });

  it('S13 AS-37: with every breaker open the accept route answers, readiness stays ready and liveness is unaffected', async () => {
    await openCreateBreaker();
    t.provider.scriptRepeat('find', { kind: 'http', statusCode: 503 }, 10);
    t.provider.scriptRepeat('cancel', { kind: 'http', statusCode: 503 }, 10);
    t.provider.scriptRepeat('retrieve', { kind: 'http', statusCode: 503 }, 10);
    t.provider.scriptRepeat('refunds', { kind: 'http', statusCode: 503 }, 10);
    for (let i = 0; i < 10; i++) {
      await provider.findIntentByReference(`order-${i}`);
      await provider.cancelIntent(`pi_${i}`, `cancel:${i}`);
      await provider.retrieveIntent(`pi_${i}`);
      await provider.findRefunds(`pi_${i}`);
    }
    for (const b of [
      'create_intent',
      'retrieve_intent',
      'cancel_intent',
      'refund',
    ])
      expect(gauge(b)).toBe(1);

    const buyer = await payableBuyer(t);
    const started = performance.now();
    const res = await t
      .as(buyer.user)
      .post('/api/payments/intents')
      .set('Idempotency-Key', 'key-all-open-0001')
      .send({ orderId: buyer.order.orderId, paymentMethodId: 'pm_x' });
    expect(res.status).toBe(202);
    expect(performance.now() - started).toBeLessThan(300);
    await t.http().get('/health/ready').expect(200);
    await t.http().get('/health/live').expect(200);
  });

  it('S13 AS-38: breakers are separate: with create open, lookups and cancels still reach the provider; with the lookup breaker open, charges still do', async () => {
    await openCreateBreaker();
    const finds = t.provider.count('find');
    const cancels = t.provider.count('cancel');
    await provider.findIntentByReference('order-1');
    await provider.cancelIntent('pi_1', 'cancel:1');
    expect(t.provider.count('find')).toBe(finds + 1);
    expect(t.provider.count('cancel')).toBe(cancels + 1);

    t.clock.advance(MINUTE);
    t.provider.scriptRepeat('find', { kind: 'http', statusCode: 503 }, 10);
    for (let i = 0; i < 10; i++)
      await provider.findIntentByReference(`order-${i}`);
    expect(gauge('retrieve_intent')).toBe(1);
    const [id] = await pending(1);
    const creates = t.provider.count('create');
    await deliverCharge(t, id);
    expect(t.provider.count('create')).toBe(creates + 1);
    expect(await paymentRow(t.app, id)).toMatchObject({ status: 'COMPLETED' });
  });
});
