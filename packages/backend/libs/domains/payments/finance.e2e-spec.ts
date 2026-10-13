import { Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  assertBooksHealthy,
  balanceOf,
  count,
  orderPaidEvent,
  sql,
} from './testing/ledger-fixtures';
import {
  FakeProviderStatement,
  statementLine,
} from './testing/fake-provider-statement';
import { PROVIDER_STATEMENT } from './domain/ledger-ports';
import { ReconciliationRunService } from './application/reconciliation-run.service';
import { SettlementConsumer } from './infra/settlement.consumer';
import { LedgerModule } from './ledger.module';
import { LedgerProcessingModule } from './ledger-processing.module';

@Module({ imports: [LedgerModule, LedgerProcessingModule] })
class FinanceProbeModule {}

const reconFake = new FakeProviderStatement();

/**
 * The money chain end to end on the real test Postgres (partitioned ledger and
 * deferred constraint trigger): capture, settlement and refund. Payouts moved
 * to S15; reconciliation has its own specs (reconciliation-*.e2e-spec.ts).
 */
describe('Finance chain: store guard, capture, settlement and refund (e2e)', () => {
  let t: LedgerTestApp;
  let consumer: SettlementConsumer;

  beforeAll(async () => {
    t = await createLedgerApp({
      extraImports: [FinanceProbeModule],
      overrides: [{ provide: PROVIDER_STATEMENT, useValue: reconFake }],
    });
    consumer = t.app.get(SettlementConsumer, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    reconFake.reset();
  });

  const logical = async (accountId: string) =>
    (
      await t.ledger.getBalances({ accountIds: [accountId], currency: 'EUR' })
    ).get(accountId)!.balanceMinor;

  it('the database itself rejects an unbalanced journal at COMMIT (deferred constraint trigger)', async () => {
    const j = uuidv4();
    await expect(
      t.sequelize.transaction(async (transaction) => {
        await t.sequelize.query(
          `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount) VALUES (:j, 'ADJUSTMENT', 'A', 100), (:j, 'ADJUSTMENT', 'B', -99)`,
          { replacements: { j }, transaction },
        );
      }),
    ).rejects.toThrow(/unbalanced ledger journal/);
    expect(await count(t.app, 'LedgerEntry')).toBe(0);
  });

  it('a captured payment settles to the cent across shops exactly once on redelivery, and a refund reverses it', async () => {
    const [a, b, c] = [uuidv4(), uuidv4(), uuidv4()].sort();
    const payment = {
      paymentId: uuidv4(),
      orderId: uuidv4(),
      paymentRef: `pi_${uuidv4().slice(0, 8)}`,
      userId: uuidv4(),
      amountMinor: 1050,
      currency: 'EUR',
    };
    const first = await t.inTx((tx) =>
      t.ledger.recordPaymentCaptured(payment, tx),
    );
    const replay = await t.inTx((tx) =>
      t.ledger.recordPaymentCaptured(payment, tx),
    );
    expect(replay.journalId).toBe(first.journalId);

    const event = orderPaidEvent({
      orderId: payment.orderId,
      totalMinor: 1050,
      shops: [a, b, c].map((shopId) => ({ shopId, subtotalMinor: 350 })),
    });
    await consumer.project([event]);
    await consumer.project([event]); // redelivery

    expect(
      await Promise.all([a, b, c].map((s) => balanceOf(t.app, `SHOP_${s}`))),
    ).toEqual([334, 333, 333]);
    expect(await logical('MARKETPLACE_CLEARING')).toBe(0);

    const refundInput = {
      paymentId: payment.paymentId,
      refundRef: 're_1',
      amountMinor: 1050,
      currency: 'EUR',
    };
    await t.inTx((tx) => t.ledger.recordPaymentRefunded(refundInput, tx));
    await t.inTx((tx) => t.ledger.recordPaymentRefunded(refundInput, tx));

    for (const s of [a, b, c]) {
      expect(await balanceOf(t.app, `SHOP_${s}`)).toBe(0);
    }
    expect(await logical('MARKETPLACE_CLEARING')).toBe(0);
    expect(await logical('PLATFORM_FEES')).toBe(0);
    expect(await logical('PROVIDER_CLEARING')).toBe(0);
    await assertBooksHealthy(t.app);
  });

  it('payout debits move shop money out once per reference, and a reversal returns it', async () => {
    const [ok, broken] = [uuidv4(), uuidv4()];
    for (const s of [ok, broken]) {
      await t.inTx((tx) =>
        t.ledger.postJournal(
          {
            kind: 'ADJUSTMENT',
            reference: `fund-${s}`,
            currency: 'EUR',
            lines: [
              { accountId: 'MARKETPLACE_CLEARING', amountMinor: -5000 },
              { accountId: `SHOP_${s}`, amountMinor: 5000 },
            ],
          },
          tx,
        ),
      );
    }
    const payout = (s: string) =>
      t.inTx((tx) =>
        t.ledger.postJournal(
          {
            kind: 'PAYOUT',
            reference: `payout-${s}-2026-09-28`,
            currency: 'EUR',
            lines: [
              { accountId: `SHOP_${s}`, amountMinor: -5000 },
              { accountId: 'PAYOUT_CLEARING', amountMinor: 5000 },
            ],
          },
          tx,
        ),
      );
    const first = await payout(ok);
    const again = await payout(ok); // idempotent re-run
    await payout(broken);
    expect(first.created).toBe(true);
    expect(again).toEqual({ journalId: first.journalId, created: false });
    expect(await balanceOf(t.app, `SHOP_${ok}`)).toBe(0);
    expect(await logical('PAYOUT_CLEARING')).toBe(10000);

    // the transfer for `broken` failed: the debit is reversed
    await t.inTx((tx) =>
      t.ledger.postJournal(
        {
          kind: 'ADJUSTMENT',
          reference: `payout-failed-${broken}`,
          currency: 'EUR',
          lines: [
            { accountId: 'PAYOUT_CLEARING', amountMinor: -5000 },
            { accountId: `SHOP_${broken}`, amountMinor: 5000 },
          ],
        },
        tx,
      ),
    );
    expect(await balanceOf(t.app, `SHOP_${broken}`)).toBe(5000);
    expect(await logical('PAYOUT_CLEARING')).toBe(5000);
    await assertBooksHealthy(t.app);
  });

  it('daily reconciliation flags missing-in-ledger, missing-at-provider and amount mismatches', async () => {
    const day = '2026-10-04';
    t.clock.set(new Date('2026-10-06T02:30:00.000Z'));
    for (const paymentRef of ['match', 'wrong-amount', 'ours-only']) {
      t.clock.set(new Date(`${day}T12:00:00.000Z`));
      await t.inTx((tx) =>
        t.ledger.recordPaymentCaptured(
          {
            paymentId: uuidv4(),
            orderId: uuidv4(),
            paymentRef,
            userId: uuidv4(),
            amountMinor: 100,
            currency: 'EUR',
          },
          tx,
        ),
      );
    }
    t.clock.set(new Date('2026-10-06T02:30:00.000Z'));
    reconFake.lines = [
      statementLine({ reference: 'match', amount: 100 }),
      statementLine({ reference: 'wrong-amount', amount: 150 }),
      statementLine({ reference: 'stripe-only', amount: 100 }),
    ];

    const outcome = await t.app
      .get(ReconciliationRunService, { strict: false })
      .runDay(day, {});
    expect(outcome.outcome).toBe('completed');

    const issues = await sql<{ kind: string; reference: string }>(
      t.app,
      `SELECT kind, reference FROM "ReconciliationIssue" ORDER BY reference`,
    );
    expect(issues).toEqual([
      { kind: 'MISSING_AT_PROVIDER', reference: 'ours-only' },
      { kind: 'MISSING_IN_LEDGER', reference: 'stripe-only' },
      { kind: 'AMOUNT_MISMATCH', reference: 'wrong-amount' },
    ]);
    expect(await count(t.app, 'ReconciliationRun')).toBe(1);

    // a completed day is final: running it again changes nothing
    await t.app
      .get(ReconciliationRunService, { strict: false })
      .runDay(day, {});
    expect(await count(t.app, 'ReconciliationRun')).toBe(1);
    expect(await count(t.app, 'ReconciliationIssue')).toBe(3);
  });
});
