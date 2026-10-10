import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PaymentQueryService } from './application/payment-query.service';
import { PAYMENT_REPOSITORY, type PaymentRepository } from './domain/ports';
import {
  createPaymentsApp,
  ledgerOf,
  paymentRow,
  payableBuyer,
  seedPayment,
  type PaymentsTestApp,
} from './testing';

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('Payments: exported status service and provider refresh', () => {
  let t: PaymentsTestApp;
  let query: PaymentQueryService;

  beforeAll(async () => {
    t = await createPaymentsApp();
    query = t.app.get(PaymentQueryService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  /** A payment in `status` with provider reference `ref`, plus the intent the provider holds for it. */
  const payment = async (
    status: string,
    ref: string,
    over: Record<string, unknown> = {},
    intentStatus?: string,
  ) => {
    const user = await t.newUser();
    const seeded = await seedPayment(t.app, {
      userId: user.id,
      status,
      providerRef: ref,
      version: 2,
      chargeAttemptedAt: t.clock.now(),
      chargeAttempts: 1,
      ...over,
    });
    if (intentStatus)
      t.provider.seedIntent({
        id: ref,
        orderId: seeded.orderId,
        amount: 2_500,
        currency: 'eur',
        status: intentStatus,
      });
    return { ...seeded, user };
  };

  describe('the mapping (AS-55)', () => {
    it.each([
      ['PENDING', 'PENDING'],
      ['UNKNOWN', 'PENDING'],
      ['COMPLETED', 'COMPLETED'],
      ['REFUND_PENDING', 'COMPLETED'],
      ['REFUNDED', 'REFUNDED'],
      ['FAILED', 'FAILED'],
      ['CANCELLED', 'FAILED'],
    ])(
      'S13 AS-55: %s is reported as %s, with only the six fields of the view',
      async (stored, reported) => {
        const p = await payment(stored, `pi_${stored}`, {
          clientSecret: stored === 'PENDING' ? 'cs_never_returned' : null,
          requiresAction: stored === 'PENDING',
          failureCode: stored === 'FAILED' ? 'card_declined' : null,
        });

        const view = await query.getPaymentStatus(`pi_${stored}`);

        expect(view).toEqual({
          paymentId: p.id,
          paymentRef: `pi_${stored}`,
          orderId: p.orderId,
          status: reported,
          amountMinor: 2_500,
          currency: 'EUR',
        });
        expect(JSON.stringify(view)).not.toContain('cs_never_returned');
        expect(JSON.stringify(view)).not.toContain(p.user.id);
        expect(JSON.stringify(view)).not.toContain('pm_card_visa');
      },
    );

    it('S13 AS-55: an unknown, empty or 256-character reference is null, and the long and empty ones touch no table', async () => {
      await payment('COMPLETED', 'pi_known');
      const repo = t.app.get<PaymentRepository>(PAYMENT_REPOSITORY, {
        strict: false,
      });
      const lookups: string[] = [];
      t.patch(
        repo,
        'findByProviderRef',
        (original) =>
          ((ref: string) => {
            lookups.push(ref);
            return original(ref);
          }) as never,
      );

      expect(await query.getPaymentStatus('pi_missing')).toBeNull();
      expect(await query.getPaymentStatus('')).toBeNull();
      expect(await query.getPaymentStatus('p'.repeat(256))).toBeNull();
      expect(await query.getPaymentStatus('p'.repeat(255))).toBeNull();
      expect(lookups).toEqual(['pi_missing', 'p'.repeat(255)]);
    });
  });

  describe('the refresh from the provider (AS-56)', () => {
    it('S13 AS-56: a payment the provider says succeeded becomes COMPLETED once, through the shared step: one journal, one event, one push', async () => {
      const p = await payment(
        'PENDING',
        'pi_1',
        { requiresAction: true, clientSecret: 'cs_3ds' },
        'succeeded',
      );
      t.realtime.published.length = 0;

      const view = await query.getPaymentStatus('pi_1');
      await settle();

      expect(view).toMatchObject({ status: 'COMPLETED', paymentRef: 'pi_1' });
      expect(await paymentRow(t.app, p.id)).toMatchObject({
        status: 'COMPLETED',
        version: 3,
        requiresAction: false,
        clientSecret: null,
      });
      expect(t.provider.count('retrieve')).toBe(1);
      expect(t.provider.calls.find((c) => c.op === 'retrieve')).toMatchObject({
        subject: 'pi_1',
        timeoutMs: 2_000,
      });
      expect(await ledgerOf(t.app, p.id)).toHaveLength(3);
      expect(
        (await outboxRowsFor(t.app, p.id)).filter(
          (r) => r.type === 'payments.payment_succeeded',
        ),
      ).toHaveLength(1);
      expect(t.realtime.published).toHaveLength(1);
    });

    it('S13 AS-56: ten callers at once cause one transition and one retrieval', async () => {
      const p = await payment(
        'PENDING',
        'pi_race',
        { requiresAction: true },
        'succeeded',
      );
      t.realtime.published.length = 0;

      const views = await Promise.all(
        Array.from({ length: 10 }, () => query.getPaymentStatus('pi_race')),
      );
      await settle();

      expect(views.some((v) => v?.status === 'COMPLETED')).toBe(true);
      for (const v of views)
        expect(['PENDING', 'COMPLETED']).toContain(v!.status);
      expect(t.provider.count('retrieve')).toBe(1);
      expect(await paymentRow(t.app, p.id)).toMatchObject({
        status: 'COMPLETED',
        version: 3,
      });
      expect(await ledgerOf(t.app, p.id)).toHaveLength(3);
      expect(t.realtime.published).toHaveLength(1);
      expect(await query.getPaymentStatus('pi_race')).toMatchObject({
        status: 'COMPLETED',
      });
      expect(t.provider.count('retrieve')).toBe(1); // terminal now: no provider call
    });

    it('S13 AS-56: a provider that is down, slow or behind an open breaker leaves the stored status, throws nothing and changes nothing', async () => {
      const down = await payment('PENDING', 'pi_down', {}, 'succeeded');
      t.provider.script('retrieve', { kind: 'http', statusCode: 503 });
      await expect(query.getPaymentStatus('pi_down')).resolves.toMatchObject({
        status: 'PENDING',
      });
      expect(await paymentRow(t.app, down.id)).toMatchObject({
        status: 'PENDING',
        version: 2,
      });

      const slow = await payment('PENDING', 'pi_slow', {}, 'succeeded');
      t.provider.script('retrieve', { kind: 'timeout' });
      await expect(query.getPaymentStatus('pi_slow')).resolves.toMatchObject({
        status: 'PENDING',
      });
      expect(await paymentRow(t.app, slow.id)).toMatchObject({
        status: 'PENDING',
        version: 2,
      });

      // the breaker of the lookups is open: no call reaches the provider
      t.provider.scriptRepeat(
        'retrieve',
        { kind: 'http', statusCode: 503 },
        10,
      );
      for (let i = 0; i < 10; i++) {
        const other = await payment('PENDING', `pi_o${i}`, {}, 'succeeded');
        await query.getPaymentStatus(`pi_o${i}`);
        void other;
      }
      expect(
        MetricsRegistry.value('circuit_breaker_open', {
          breaker: 'retrieve_intent',
        }),
      ).toBe(1);
      const calls = t.provider.calls.length;
      const blocked = await payment('PENDING', 'pi_blocked', {}, 'succeeded');
      await expect(query.getPaymentStatus('pi_blocked')).resolves.toMatchObject(
        { status: 'PENDING' },
      );
      expect(t.provider.calls.length).toBe(calls);
      expect(await paymentRow(t.app, blocked.id)).toMatchObject({
        status: 'PENDING',
      });
    });

    it('S13 AS-56: a final payment is never looked up at the provider', async () => {
      for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'])
        await payment(status, `pi_final_${status}`, {}, 'succeeded');
      for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'])
        await query.getPaymentStatus(`pi_final_${status}`);
      expect(t.provider.calls).toHaveLength(0);
    });

    it('S13 AS-56: an UNKNOWN payment is settled by the same lookup by our reference as the resolver makes', async () => {
      const buyer = await payableBuyer(t);
      const seeded = await seedPayment(t.app, {
        userId: buyer.user.id,
        orderId: buyer.order.orderId,
        status: 'UNKNOWN',
        version: 2,
        providerRef: 'pi_unk',
        chargeAttemptedAt: t.clock.now(),
        unknownSince: t.clock.now(),
        nextResolveAt: t.clock.now(),
      });
      t.provider.seedIntent({
        id: 'pi_unk',
        orderId: buyer.order.orderId,
        amount: 2_500,
        currency: 'eur',
        status: 'succeeded',
      });

      const view = await query.getPaymentStatus('pi_unk');

      expect(view).toMatchObject({ status: 'COMPLETED' });
      expect(await paymentRow(t.app, seeded.id)).toMatchObject({
        status: 'COMPLETED',
      });
      expect(t.provider.count('find')).toBe(1);
      expect(t.provider.count('retrieve')).toBe(0);
    });
  });
});
