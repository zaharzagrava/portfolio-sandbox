import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { PaymentChargeService } from './application/payment-charge.service';
import { PaymentTransitionService } from './application/payment-transition.service';
import {
  PAYMENT_HISTORY_REPOSITORY,
  type PaymentHistoryRepository,
} from './domain/ports';
import {
  createPaymentsApp,
  historyOf,
  ledgerOf,
  paymentRow,
  publishOrderReserved,
  seedPayment,
  type PaymentsTestApp,
} from './testing';

const settle = () => new Promise((r) => setTimeout(r, 120));

describe('Payments: guarded transitions and races', () => {
  let t: PaymentsTestApp;
  let transitions: PaymentTransitionService;

  beforeAll(async () => {
    t = await createPaymentsApp();
    transitions = t.app.get(PaymentTransitionService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const eventsOf = async (paymentId: string, type: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.type === type);
  const pushesOf = (paymentId: string) =>
    t.realtime.published.filter(
      (p) => (p.data as { paymentId: string }).paymentId === paymentId,
    );

  it('S13 AS-40: a resolution, a refresh and a late result at once, 50 times: one UNKNOWN to COMPLETED, one history row, one journal, one event, one push, no error for the losers', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 50; i++) {
      const { id } = await seedPayment(t.app, {
        userId: user.id,
        status: 'UNKNOWN',
        version: 2,
        chargeAttemptedAt: t.clock.now(),
        chargeAttempts: 1,
        unknownSince: t.clock.now(),
        nextResolveAt: t.clock.now(),
      });
      t.realtime.published.length = 0;

      const results = await Promise.all(
        ['system:resolver', 'system:refresh', 'system:processor'].map((actor) =>
          transitions.apply(id, { type: 'succeed' }, actor, {
            providerRef: `pi_${i}`,
          }),
        ),
      );
      await settle();

      expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
      for (const r of results)
        expect(['applied', 'already_applied']).toContain(r.kind);
      const row = (await paymentRow(t.app, id))!;
      expect(row).toMatchObject({
        status: 'COMPLETED',
        version: 3,
        providerRef: `pi_${i}`,
        nextResolveAt: null,
        clientSecret: null,
        paymentMethodToken: null,
      });
      expect(
        (await historyOf(t.app, id)).filter((h) => h.toStatus === 'COMPLETED'),
      ).toEqual([
        expect.objectContaining({ version: 3, fromStatus: 'UNKNOWN' }),
      ]);
      const journal = await ledgerOf(t.app, id);
      expect(journal).toHaveLength(3);
      expect(journal.reduce((s, l) => s + Number(l.amount), 0)).toBe(0);
      expect(new Set(journal.map((l) => l.journalId)).size).toBe(1);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(1);
      expect(pushesOf(id)).toHaveLength(1);
    }
  }, 180_000);

  it('S13 AS-41: a terminal status is never revisited: a late success for a FAILED payment and a late failure for a COMPLETED one change nothing, are logged with both states and counted', async () => {
    const user = await t.newUser();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const before =
      MetricsRegistry.value('payments_conflicting_provider_state_total') ?? 0;

    const failed = await seedPayment(t.app, {
      userId: user.id,
      status: 'FAILED',
      version: 2,
      failureCode: 'card_declined',
    });
    const late = await transitions.apply(
      failed.id,
      { type: 'succeed' },
      'system:resolver',
      {
        providerRef: 'pi_late',
      },
    );
    expect(late.kind).toBe('conflict');
    expect(await paymentRow(t.app, failed.id)).toMatchObject({
      status: 'FAILED',
      version: 2,
      providerRef: null,
    });

    const done = await seedPayment(t.app, {
      userId: user.id,
      status: 'COMPLETED',
      version: 2,
      providerRef: 'pi_ok',
    });
    const lateFail = await transitions.apply(
      done.id,
      { type: 'fail', code: 'card_declined' },
      'system:resolver',
    );
    expect(lateFail.kind).toBe('conflict');
    expect(await paymentRow(t.app, done.id)).toMatchObject({
      status: 'COMPLETED',
      version: 2,
      failureCode: null,
    });

    expect(
      MetricsRegistry.value('payments_conflicting_provider_state_total'),
    ).toBe(before + 2);
    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(
      logged.some((m) => m.includes('FAILED') && m.includes('succeed')),
    ).toBe(true);
    expect(
      logged.some((m) => m.includes('COMPLETED') && m.includes('fail')),
    ).toBe(true);
    for (const id of [failed.id, done.id]) {
      expect(await ledgerOf(t.app, id)).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_succeeded')).toHaveLength(0);
      expect(await eventsOf(id, 'payments.payment_failed')).toHaveLength(0);
    }
    error.mockRestore();
  });

  it('S13 AS-42: PENDING, UNKNOWN, COMPLETED, REFUND_PENDING, REFUNDED leaves one history row per move in order with the version +1 each; history cannot be changed from the domain', async () => {
    const user = await t.newUser();
    const { id } = await seedPayment(t.app, {
      userId: user.id,
      chargeAttemptedAt: t.clock.now(),
      chargeAttempts: 1,
    });

    await transitions.apply(
      id,
      { type: 'markUnknown', reason: 'provider_timeout' },
      'system:processor',
    );
    await transitions.apply(id, { type: 'succeed' }, 'system:resolver', {
      providerRef: 'pi_1',
    });
    await transitions.apply(id, { type: 'requestRefund' }, 'system:refund');
    await transitions.apply(id, { type: 'refundSucceeded' }, 'system:refund');

    expect(await historyOf(t.app, id)).toEqual([
      expect.objectContaining({
        version: 1,
        fromStatus: null,
        toStatus: 'PENDING',
      }),
      expect.objectContaining({
        version: 2,
        fromStatus: 'PENDING',
        toStatus: 'UNKNOWN',
        reason: 'provider_timeout',
        actor: 'system:processor',
      }),
      expect.objectContaining({
        version: 3,
        fromStatus: 'UNKNOWN',
        toStatus: 'COMPLETED',
        actor: 'system:resolver',
      }),
      expect.objectContaining({
        version: 4,
        fromStatus: 'COMPLETED',
        toStatus: 'REFUND_PENDING',
        actor: 'system:refund',
      }),
      expect.objectContaining({
        version: 5,
        fromStatus: 'REFUND_PENDING',
        toStatus: 'REFUNDED',
        actor: 'system:refund',
      }),
    ]);
    expect(await paymentRow(t.app, id)).toMatchObject({
      status: 'REFUNDED',
      version: 5,
    });

    const repo = t.app.get<PaymentHistoryRepository>(
      PAYMENT_HISTORY_REPOSITORY,
      { strict: false },
    );
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(repo))
      .filter((n) => n !== 'constructor')
      .sort();
    expect(surface).toEqual(['insert', 'listByPayment']);
  });

  it('S13 AS-43: a cancel and the start of the charge at once, 50 times: exactly one wins and a cancelled payment never has a provider charge', async () => {
    const user = await t.newUser();
    const charges = t.app.get(PaymentChargeService, { strict: false });
    let cancelled = 0;
    for (let i = 0; i < 50; i++) {
      const order = await publishOrderReserved(t.app, { userId: user.id });
      const { id } = await seedPayment(t.app, {
        userId: user.id,
        orderId: order.orderId,
      });
      const before = t.provider.count('create');

      const [cancel] = await Promise.all([
        transitions.apply(
          id,
          { type: 'cancel', reason: 'order_cancelled' },
          'system:order-events',
        ),
        charges.charge(id, 0),
      ]);

      const row = (await paymentRow(t.app, id))!;
      const creates = t.provider.count('create') - before;
      if (cancel.kind === 'applied') {
        cancelled++;
        expect(row.status).toBe('CANCELLED');
        expect(row.chargeAttemptedAt).toBeNull();
        expect(creates).toBe(0);
      } else {
        expect(row.status).not.toBe('CANCELLED');
        expect(row.chargeAttemptedAt).not.toBeNull();
        expect(creates).toBe(1);
      }
    }
    // both outcomes are legitimate; the invariant above held for every run
    expect(cancelled).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
