import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { PaymentResolutionService } from './application/payment-resolution.service';
import { PaymentTransitionService } from './application/payment-transition.service';
import { PAYMENT_REPOSITORY, type PaymentRepository } from './domain/ports';
import { PaymentJobs } from './infra/payment.jobs';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  exec,
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

describe('Payments: unknown outcomes and resolution', () => {
  let t: PaymentsTestApp;
  let probe: JobsTestProbe;
  let resolver: PaymentResolutionService;
  let jobs: PaymentJobs;

  beforeAll(async () => {
    t = await createPaymentsApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
    resolver = t.app.get(PaymentResolutionService, { strict: false });
    jobs = t.app.get(PaymentJobs, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);
  const gauge = () =>
    MetricsRegistry.value('payments_unknown_oldest_age_seconds') ?? 0;
  const resolveJobs = (paymentId: string) =>
    probe.find('payments.resolve-unknown', { paymentId });

  /** A buyer whose charge timed out at the provider: UNKNOWN. */
  const unknownPayment = async (applied = false) => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    t.provider.script('create', { kind: 'timeout', applied });
    await deliverCharge(t, id);
    return { buyer, id };
  };
  const intentFor = (buyer: PayableBuyer, over: Record<string, unknown> = {}) =>
    t.provider.seedIntent({
      orderId: buyer.order.orderId,
      amount: buyer.order.totalMinor,
      currency: 'eur',
      ...over,
    });

  describe('a silent provider (AS-23)', () => {
    it('S13 AS-23: a create that hangs past its limit leaves UNKNOWN(provider_timeout), books and publishes nothing, schedules the first check 30 s on and is never sent twice', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      const before =
        MetricsRegistry.value('payments_unknown_outcomes_total') ?? 0;
      t.provider.script('create', { kind: 'timeout' });

      await deliverCharge(t, id); // resolves: the command is acknowledged

      const row = (await paymentRow(t.app, id))!;
      expect(row).toMatchObject({
        status: 'UNKNOWN',
        version: 2,
        resolveChecks: 0,
      });
      expect(row.unknownSince).not.toBeNull();
      expect(row.nextResolveAt!.getTime() - row.unknownSince!.getTime()).toBe(
        30 * SECOND,
      );
      expect(await historyOf(t.app, id)).toEqual([
        expect.objectContaining({ version: 1 }),
        expect.objectContaining({
          version: 2,
          toStatus: 'UNKNOWN',
          reason: 'provider_timeout',
        }),
      ]);
      expect(await ledgerOf(t.app, id)).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(0);
      expect(MetricsRegistry.value('payments_unknown_outcomes_total')).toBe(
        before + 1,
      );
      expect(await resolveJobs(id)).toHaveLength(1);
      expect(t.provider.calls[0].timeoutMs).toBe(8_000);

      for (let i = 0; i < 3; i++) await deliverCharge(t, id); // redeliveries and restarts
      expect(t.provider.count('create')).toBe(1);
      expect((await paymentRow(t.app, id))!.version).toBe(2);
    });
  });

  describe('the lookup by our reference (AS-24 to AS-28)', () => {
    it('S13 AS-24: when the provider has the charge, the lookup completes the payment through the shared step: one journal, one event, one push, no second create', async () => {
      const { id } = await unknownPayment(true);
      t.realtime.published.length = 0;

      await resolver.resolve(id);
      await new Promise((r) => setTimeout(r, 120));

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        version: 3,
        providerRef: 'pi_1',
        nextResolveAt: null,
      });
      expect(await ledgerOf(t.app, id)).toHaveLength(3);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
      expect(t.realtime.published).toHaveLength(1);
      expect(t.provider.count('create')).toBe(1);
      expect(t.provider.count('find')).toBe(1);
      expect(t.provider.calls.find((c) => c.op === 'find')).toMatchObject({
        subject: (await paymentRow(t.app, id))!.orderId,
        timeoutMs: 4_000,
      });
    });

    it('S13 AS-25: a canceled intent and one that needs a new payment method fail the payment with a code, publish once and never call create', async () => {
      const a = await unknownPayment();
      const b = await unknownPayment();
      const [ra, rb] = [
        (await paymentRow(t.app, a.id))!,
        (await paymentRow(t.app, b.id))!,
      ];
      t.provider.seedIntent({
        orderId: ra.orderId,
        amount: 2_500,
        status: 'canceled',
      });
      t.provider.seedIntent({
        orderId: rb.orderId,
        amount: 2_500,
        status: 'requires_payment_method',
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
        },
      });
      const creates = t.provider.count('create');

      await resolver.resolve(a.id);
      await resolver.resolve(b.id);

      expect(await paymentRow(t.app, a.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_canceled',
      });
      expect(await paymentRow(t.app, b.id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'insufficient_funds',
      });
      expect(await eventsOf(a.id, 'payments.payment_failed')).toHaveLength(1);
      expect(await eventsOf(b.id, 'payments.payment_failed')).toHaveLength(1);
      expect(t.provider.count('create')).toBe(creates);
    });

    it('S13 AS-26: with no record at the provider the payment stays UNKNOWN until 60 minutes after the attempt, then FAILED(no_provider_record)', async () => {
      const { id } = await unknownPayment();
      const attemptedAt = (await paymentRow(t.app, id))!.chargeAttemptedAt!;

      t.clock.set(new Date(attemptedAt.getTime() + 60 * MINUTE - SECOND));
      await resolver.resolve(id);
      const waiting = (await paymentRow(t.app, id))!;
      expect(waiting).toMatchObject({
        status: 'UNKNOWN',
        version: 2,
        resolveChecks: 1,
      });
      expect(waiting.nextResolveAt!.getTime()).toBeGreaterThanOrEqual(
        t.clock.now().getTime(),
      );
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(0);

      t.clock.set(new Date(attemptedAt.getTime() + 60 * MINUTE));
      await resolver.resolve(id);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'no_provider_record',
        version: 3,
      });
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(1);
      expect(t.provider.count('create')).toBe(1);
    });

    it.each([
      ['a timeout', { kind: 'timeout' } as const],
      ['an error answer', { kind: 'http', statusCode: 503 } as const],
    ])(
      'S13 AS-27: %s while resolving leaves the payment UNKNOWN with the next check inside the jittered backoff bounds',
      async (_label, step) => {
        const { id } = await unknownPayment();
        for (let n = 0; n < 4; n++) {
          t.provider.script('find', step);
          await resolver.resolve(id);
          const row = (await paymentRow(t.app, id))!;
          expect(row).toMatchObject({
            status: 'UNKNOWN',
            resolveChecks: n + 1,
          });
          const delay = row.nextResolveAt!.getTime() - t.clock.now().getTime();
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(
            Math.min(15 * MINUTE, 30 * SECOND * 2 ** n),
          );
        }
        expect(await resolveJobs(id)).not.toHaveLength(0);
      },
    );

    it('S13 AS-27: an open breaker makes the lookup wait without reaching the provider', async () => {
      const { id } = await unknownPayment();
      t.provider.scriptRepeat('find', { kind: 'http', statusCode: 503 }, 10);
      for (let i = 0; i < 10; i++) await resolver.resolve(id);
      expect(
        MetricsRegistry.value('circuit_breaker_open', {
          breaker: 'retrieve_intent',
        }),
      ).toBe(1);
      const calls = t.provider.count('find');

      await resolver.resolve(id);

      expect(t.provider.count('find')).toBe(calls);
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
    });

    it('S13 AS-27: stuck for over 24 hours: one warning an hour, the age gauge above 86,400 s, still UNKNOWN', async () => {
      const { id } = await unknownPayment();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      await exec(
        t.app,
        `UPDATE "Payment" SET "unknownSince" = :since, "nextResolveAt" = :due WHERE "id" = :id`,
        {
          id,
          since: new Date(t.clock.now().getTime() - 25 * HOUR),
          due: t.clock.now(),
        },
      );
      const stuck = () =>
        warn.mock.calls.filter((c) => String(c[0]).includes('stuck')).length;
      t.provider.scriptRepeat('find', { kind: 'http', statusCode: 503 }, 5);

      await resolver.resolve(id);
      expect(stuck()).toBe(1);
      await resolver.resolve(id);
      expect(stuck()).toBe(1); // throttled to one an hour
      t.clock.advance(HOUR + SECOND);
      await resolver.resolve(id);
      expect(stuck()).toBe(2);

      await exec(
        t.app,
        `UPDATE "Payment" SET "nextResolveAt" = :due WHERE "id" = :id`,
        { id, due: t.clock.now() },
      );
      await jobs.sweepUnknown();
      expect(gauge()).toBeGreaterThan(86_400);
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
      warn.mockRestore();
    });

    it('S13 AS-28: a customer who has not finished: the lookup moves the payment back to PENDING with customer action and the secret', async () => {
      const { buyer, id } = await unknownPayment();
      intentFor(buyer, {
        status: 'requires_action',
        client_secret: 'pi_secret_lookup',
      });

      await resolver.resolve(id);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        version: 3,
        requiresAction: true,
        clientSecret: 'pi_secret_lookup',
        providerRef: 'pi_seed_1',
        nextResolveAt: null,
      });
      expect(await historyOf(t.app, id)).toContainEqual(
        expect.objectContaining({
          version: 3,
          fromStatus: 'UNKNOWN',
          toStatus: 'PENDING',
        }),
      );
    });

    it('S13 AS-22: a lookup whose answer contradicts our record stays UNKNOWN, is logged as an error and counted by field', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.provider.script('create', { kind: 'ok', overrides: { amount: 999 } });
      await deliverCharge(t, id);
      expect(await paymentRow(t.app, id)).toMatchObject({ status: 'UNKNOWN' });
      // what the provider holds for this order disagrees with ours (the healthy copy of the first answer is dropped)
      t.provider.intents.clear();
      intentFor(buyer, { amount: 999 });
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const before =
        MetricsRegistry.value('payments_provider_mismatch_total', {
          field: 'amount',
        }) ?? 0;

      await resolver.resolve(id);

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'UNKNOWN',
        version: 2,
      });
      expect(
        MetricsRegistry.value('payments_provider_mismatch_total', {
          field: 'amount',
        }),
      ).toBe(before + 1);
      expect(error).toHaveBeenCalled();
      expect(await ledgerOf(t.app, id)).toHaveLength(0);
      error.mockRestore();
    });
  });

  describe('lost jobs and crashes (AS-29, AS-30)', () => {
    it('S13 AS-29: a lost resolution job is replaced by the sweep within a minute of the due time; two sweepers at once make one job and one lookup', async () => {
      const { id } = await unknownPayment(true);
      await exec(
        t.app,
        `DELETE FROM "Job" WHERE "type" = 'payments.resolve-unknown'`,
      );
      expect(await resolveJobs(id)).toHaveLength(0);
      t.clock.advance(31 * SECOND);

      await Promise.all([jobs.sweepUnknown(), jobs.sweepUnknown()]);

      const queued = await resolveJobs(id);
      expect(queued).toHaveLength(1);
      await jobs.resolveUnknown(queued[0].payload as { paymentId: string });
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
      });
      expect(t.provider.count('find')).toBe(1);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
    });

    it('S13 AS-30: a recorded attempt without an answer becomes UNKNOWN(crash_recovery) on redelivery with no second create, and is settled by lookup', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      // The first run reached the provider and recorded its attempt, then the process was killed before applying the answer.
      const transitions = t.app.get(PaymentTransitionService, {
        strict: false,
      });
      const restore = t.patch(
        transitions,
        'apply',
        () =>
          (async () => {
            throw new Error('killed');
          }) as never,
      );
      await expect(deliverCharge(t, id)).rejects.toThrow('killed');
      restore();
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'PENDING',
        chargeAttempts: 1,
      });
      expect((await paymentRow(t.app, id))!.chargeAttemptedAt).not.toBeNull();
      expect(t.provider.count('create')).toBe(1);

      await deliverCharge(t, id); // redelivery

      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'UNKNOWN',
        version: 2,
      });
      expect(await historyOf(t.app, id)).toContainEqual(
        expect.objectContaining({
          toStatus: 'UNKNOWN',
          reason: 'crash_recovery',
        }),
      );
      expect(t.provider.count('create')).toBe(1);

      await resolver.resolve(id); // the provider has the charge from the first run
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
      });
      expect(t.provider.count('create')).toBe(1);
    });

    it('S13 AS-30: a stop before the attempt is recorded costs nothing: the redelivery charges normally with one create', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      const repo = t.app.get<PaymentRepository>(PAYMENT_REPOSITORY, {
        strict: false,
      });
      let killed = false;
      t.patch(
        repo,
        'startCharge',
        (original) =>
          (async (...args: Parameters<PaymentRepository['startCharge']>) => {
            if (!killed) {
              killed = true;
              throw new Error('killed before the attempt was recorded');
            }
            return original(...args);
          }) as never,
      );

      await expect(deliverCharge(t, id)).rejects.toThrow('killed');
      expect(t.provider.calls).toHaveLength(0);
      expect((await paymentRow(t.app, id))!.chargeAttemptedAt).toBeNull();

      await deliverCharge(t, id);

      expect(t.provider.count('create')).toBe(1);
      expect(await paymentRow(t.app, id)).toMatchObject({
        status: 'COMPLETED',
        version: 2,
      });
    });
  });
});
