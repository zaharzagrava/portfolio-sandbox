import { Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  assertBooksHealthy,
  balanceOf,
  count,
  journalEvents,
  orderPaidEvent,
  sql,
} from './testing/ledger-fixtures';
import { JournalConflict, JournalInvalid } from './domain/ledger-errors';
import { journalId } from './domain/journal';
import { shardOf } from './domain/shard';
import { LedgerModule } from './ledger.module';
import { LedgerProcessingModule } from './ledger-processing.module';
import { SettlementConsumer } from './infra/settlement.consumer';
import { LedgerJobs } from './infra/ledger.jobs';
import { LedgerPostingAdapter } from './infra/ledger-posting.adapter';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

@Module({
  imports: [LedgerModule, LedgerProcessingModule],
  providers: [LedgerPostingAdapter],
  exports: [LedgerPostingAdapter],
})
class PaymentPostingsProbeModule {}

describe('Ledger: payment capture, refund and settlement', () => {
  let t: LedgerTestApp;
  let consumer: SettlementConsumer;
  let jobs: LedgerJobs;

  beforeAll(async () => {
    t = await createLedgerApp({ extraImports: [PaymentPostingsProbeModule] });
    consumer = t.app.get(SettlementConsumer, { strict: false });
    jobs = t.app.get(LedgerJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const captureInput = (over: Record<string, unknown> = {}) => ({
    paymentId: uuidv4(),
    orderId: uuidv4(),
    paymentRef: `pi_${uuidv4().slice(0, 8)}`,
    userId: uuidv4(),
    amountMinor: 2500,
    currency: 'EUR',
    ...over,
  });
  type Capture = ReturnType<typeof captureInput>;
  const capture = (i: Capture) =>
    t.inTx((tx) => t.ledger.recordPaymentCaptured(i, tx));
  const refund = (i: {
    paymentId: string;
    refundRef?: string;
    amountMinor?: number;
    currency?: string;
  }) =>
    t.inTx((tx) =>
      t.ledger.recordPaymentRefunded(
        { refundRef: 're_1', amountMinor: 2500, currency: 'EUR', ...i },
        tx,
      ),
    );
  const reasonOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof JournalInvalid) return e.reason;
      if (e instanceof JournalConflict) return 'journal_conflict';
      throw e;
    }
    return 'accepted';
  };
  const lines = (journal: string) =>
    sql<{
      accountId: string;
      shard: number;
      amount: string;
      paymentId: string | null;
    }>(
      t.app,
      `SELECT "accountId", "shard", amount::text, "paymentId" FROM "LedgerEntry" WHERE "journalId" = :journal ORDER BY "accountId"`,
      { journal },
    );
  const logical = async (accountId: string) =>
    (
      await t.ledger.getBalances({ accountIds: [accountId], currency: 'EUR' })
    ).get(accountId)!.balanceMinor;
  /** Every account's entries for one payment, summed across shards: all must net to zero when the money is back. */
  const netPerAccount = (paymentId: string) =>
    sql<{ accountId: string; net: string }>(
      t.app,
      `SELECT "accountId", sum(amount)::text AS net FROM "LedgerEntry" WHERE "paymentId" = :paymentId GROUP BY "accountId"`,
      { paymentId },
    );
  const settle = (event: ReturnType<typeof orderPaidEvent>) =>
    consumer.project([event]);

  it('S14 AS-11: a capture posts SALE -2500 / +2450 / +50 on one shard and records the references as plain ids', async () => {
    const input = captureInput({ paymentRef: 'pi_1' });
    const result = await capture(input);
    expect(result).toEqual({
      journalId: journalId('SALE', input.paymentId),
      created: true,
    });
    const shard = shardOf(input.paymentId, 32);
    expect(await lines(result.journalId)).toEqual([
      {
        accountId: 'MARKETPLACE_CLEARING',
        shard,
        amount: '2450',
        paymentId: input.paymentId,
      },
      {
        accountId: 'PLATFORM_FEES',
        shard,
        amount: '50',
        paymentId: input.paymentId,
      },
      {
        accountId: 'PROVIDER_CLEARING',
        shard,
        amount: '-2500',
        paymentId: input.paymentId,
      },
    ]);
    const [header] = await sql<Record<string, unknown>>(
      t.app,
      `SELECT "kind","paymentId","orderId","paymentRef","userId","clearingMinor"::text AS "clearingMinor" FROM "LedgerJournal"`,
    );
    expect(header).toEqual({
      kind: 'SALE',
      paymentId: input.paymentId,
      orderId: input.orderId,
      paymentRef: 'pi_1',
      userId: input.userId,
      clearingMinor: '2450',
    });
    expect(
      await count(t.app, 'AccountBalance', `"accountId" LIKE :p`, {
        p: `%${input.userId}%`,
      }),
    ).toBe(0);
    expect(await journalEvents(t.app)).toHaveLength(1);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-11: the S13 adapter path passes the order and provider references through', async () => {
    const adapter = t.app.get(LedgerPostingAdapter, { strict: false });
    const input = captureInput({ paymentRef: 'pi_adapter' });
    await t.inTx(() =>
      adapter.recordCaptured({
        id: input.paymentId,
        userId: input.userId,
        orderId: input.orderId,
        amountMinor: 2500,
        currency: 'EUR',
        providerRef: 'pi_adapter',
      } as never),
    );
    const [header] = await sql<{ orderId: string; paymentRef: string }>(
      t.app,
      `SELECT "orderId","paymentRef" FROM "LedgerJournal" WHERE "kind" = 'SALE'`,
    );
    expect(header).toEqual({
      orderId: input.orderId,
      paymentRef: 'pi_adapter',
    });
    await t.inTx(() =>
      adapter.recordRefunded(
        {
          id: input.paymentId,
          userId: input.userId,
          orderId: input.orderId,
          amountMinor: 2500,
          currency: 'EUR',
          providerRef: 'pi_adapter',
        } as never,
        're_adapter',
      ),
    );
    const [refundHeader] = await sql<{ refundRef: string }>(
      t.app,
      `SELECT "refundRef" FROM "LedgerJournal" WHERE "kind" = 'REFUND'`,
    );
    expect(refundHeader.refundRef).toBe('re_adapter');
  });

  it('S14 AS-12: a repeated capture (also 20 at once) changes nothing; another amount is a conflict', async () => {
    const input = captureInput();
    const first = await capture(input);
    expect(await capture(input)).toEqual({
      journalId: first.journalId,
      created: false,
    });
    const many = await Promise.all(
      Array.from({ length: 20 }, () => capture(input)),
    );
    expect(
      many.every((r) => !r.created && r.journalId === first.journalId),
    ).toBe(true);
    expect(await count(t.app, 'LedgerEntry')).toBe(3);
    expect(await journalEvents(t.app)).toHaveLength(1);
    await expect(
      capture({ ...input, amountMinor: 2600 }),
    ).rejects.toBeInstanceOf(JournalConflict);
    expect(await count(t.app, 'LedgerEntry')).toBe(3);
    await assertBooksHealthy(t.app);
  });

  it.each([
    [{ amountMinor: 50 }, 'amount_not_above_fee'],
    [{ amountMinor: 49 }, 'amount_not_above_fee'],
    [{ amountMinor: 0 }, 'amount_not_above_fee'],
    [{ amountMinor: -1 }, 'line_amount_invalid'],
    [{ currency: 'USD' }, 'currency_unsupported'],
    [{ orderId: '' }, 'reference_invalid'],
    [{ paymentRef: '' }, 'reference_invalid'],
  ])(
    'S14 AS-13: a capture with %j is refused as %s and writes nothing',
    async (over, reason) => {
      expect(await reasonOf(capture(captureInput(over)))).toBe(reason);
      expect(await count(t.app, 'LedgerEntry')).toBe(0);
      expect(await count(t.app, 'LedgerJournal')).toBe(0);
      expect(
        await count(t.app, 'Outbox', `"type" = 'ledger.journal_posted'`),
      ).toBe(0);
    },
  );

  it('S14 AS-14: a refund of an unsettled sale reverses the three accounts on the same shards', async () => {
    const input = captureInput();
    const sale = await capture(input);
    const result = await refund({
      paymentId: input.paymentId,
      refundRef: 're_1',
    });
    expect(result).toEqual({
      journalId: journalId('REFUND', input.paymentId),
      created: true,
    });
    const shard = shardOf(input.paymentId, 32);
    expect(await lines(result.journalId)).toEqual([
      {
        accountId: 'MARKETPLACE_CLEARING',
        shard,
        amount: '-2450',
        paymentId: input.paymentId,
      },
      {
        accountId: 'PLATFORM_FEES',
        shard,
        amount: '-50',
        paymentId: input.paymentId,
      },
      {
        accountId: 'PROVIDER_CLEARING',
        shard,
        amount: '2500',
        paymentId: input.paymentId,
      },
    ]);
    expect(
      (await netPerAccount(input.paymentId)).every((r) => r.net === '0'),
    ).toBe(true);
    expect(await lines(sale.journalId)).toHaveLength(3);
    expect(await journalEvents(t.app)).toHaveLength(2);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-15: a refund of a settled sale reverses the shops shares, not the clearing, and records the settlement', async () => {
    const [a, b] = [uuidv4(), uuidv4()].sort();
    const input = captureInput({ amountMinor: 2500 });
    await capture(input);
    await settle(
      orderPaidEvent({
        orderId: input.orderId,
        shops: [
          { shopId: a, subtotalMinor: 1 },
          { shopId: b, subtotalMinor: 1 },
        ],
      }),
    );
    // shop a is paid out before the refund, so the refund takes its account below zero
    await t.inTx((tx) =>
      t.ledger.postJournal(
        {
          kind: 'PAYOUT',
          reference: 'payout-a',
          currency: 'EUR',
          lines: [
            { accountId: `SHOP_${a}`, amountMinor: -1225 },
            { accountId: 'PAYOUT_CLEARING', amountMinor: 1225 },
          ],
        },
        tx,
      ),
    );
    const result = await refund({ paymentId: input.paymentId });
    const refundLines = await lines(result.journalId);
    expect(refundLines.map((l) => [l.accountId, l.amount])).toEqual([
      ['PLATFORM_FEES', '-50'],
      ['PROVIDER_CLEARING', '2500'],
      [`SHOP_${a}`, '-1225'],
      [`SHOP_${b}`, '-1225'],
    ]);
    expect(await logical('MARKETPLACE_CLEARING')).toBe(0);
    expect(await balanceOf(t.app, `SHOP_${a}`)).toBe(-1225);
    expect(await balanceOf(t.app, `SHOP_${b}`)).toBe(0);
    const [header] = await sql<{ reversesJournalId: string }>(
      t.app,
      `SELECT "reversesJournalId" FROM "LedgerJournal" WHERE "kind" = 'REFUND'`,
    );
    expect(header.reversesJournalId).toBe(
      journalId('SETTLEMENT', input.orderId),
    );
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-16: refund guards run before the idempotency check, write nothing, and a repeat (also 20 at once) is idempotent', async () => {
    const input = captureInput();
    expect(await reasonOf(refund({ paymentId: uuidv4() }))).toBe(
      'sale_not_found',
    );
    await capture(input);
    expect(
      await reasonOf(refund({ paymentId: input.paymentId, amountMinor: 1000 })),
    ).toBe('refund_amount_mismatch');
    expect(
      await reasonOf(refund({ paymentId: input.paymentId, currency: 'USD' })),
    ).toBe('journal_currency_mismatch');
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'REFUND'`)).toBe(0);

    const first = await refund({ paymentId: input.paymentId });
    expect(await refund({ paymentId: input.paymentId })).toEqual({
      journalId: first.journalId,
      created: false,
    });
    const many = await Promise.all(
      Array.from({ length: 20 }, () => refund({ paymentId: input.paymentId })),
    );
    expect(many.every((r) => !r.created)).toBe(true);
    // a repeat with another amount is refused by the guard, not reported as a conflict
    expect(
      await reasonOf(refund({ paymentId: input.paymentId, amountMinor: 1000 })),
    ).toBe('refund_amount_mismatch');
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'REFUND'`)).toBe(1);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-17: order.paid settles the sale into the shops by largest remainder, once', async () => {
    const [a, b, c] = [uuidv4(), uuidv4(), uuidv4()].sort();
    const input = captureInput({ amountMinor: 1050 });
    await capture(input);
    await settle(
      orderPaidEvent({
        orderId: input.orderId,
        totalMinor: 1050,
        shops: [a, b, c].map((shopId) => ({ shopId, subtotalMinor: 350 })),
      }),
    );
    const id = journalId('SETTLEMENT', input.orderId);
    const rows = await lines(id);
    expect(rows.map((r) => [r.accountId, r.amount, r.paymentId])).toEqual(
      [
        ['MARKETPLACE_CLEARING', '-1000', input.paymentId],
        [`SHOP_${a}`, '334', input.paymentId],
        [`SHOP_${b}`, '333', input.paymentId],
        [`SHOP_${c}`, '333', input.paymentId],
      ].sort((x, y) => (x[0] as string).localeCompare(y[0] as string)),
    );
    expect(await logical('MARKETPLACE_CLEARING')).toBe(0);
    expect(await journalEvents(t.app)).toHaveLength(2);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-18: five simultaneous deliveries and a later one give one journal, one event, shares unchanged', async () => {
    const [a, b] = [uuidv4(), uuidv4()].sort();
    const input = captureInput({ amountMinor: 1050 });
    await capture(input);
    const event = orderPaidEvent({
      orderId: input.orderId,
      shops: [
        { shopId: a, subtotalMinor: 600 },
        { shopId: b, subtotalMinor: 400 },
      ],
    });
    await Promise.all(Array.from({ length: 5 }, () => settle(event)));
    await settle(event);
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      1,
    );
    expect(await journalEvents(t.app)).toHaveLength(2);
    expect(await balanceOf(t.app, `SHOP_${a}`)).toBe(600);
    expect(await balanceOf(t.app, `SHOP_${b}`)).toBe(400);
    await assertBooksHealthy(t.app);
  });

  it('S14 AS-19: nine classes of invalid order.paid are dead-lettered with a reason, write nothing, and the next message is processed', async () => {
    const input = captureInput({ amountMinor: 1050 });
    await capture(input);
    const shop = uuidv4();
    const good = () =>
      orderPaidEvent({
        orderId: input.orderId,
        shops: [{ shopId: shop, subtotalMinor: 1000 }],
      });
    const tamper = (mutate: (p: Record<string, any>) => void) => {
      const e = good();
      mutate(e.payload as Record<string, any>);
      return e;
    };
    const cases: Array<[string, ReturnType<typeof good>, string]> = [
      ['no shopOrders', tamper((p) => delete p.shopOrders), 'invalid_payload'],
      [
        'an empty shopOrders',
        tamper((p) => (p.shopOrders = [])),
        'invalid_payload',
      ],
      [
        'a negative subtotal',
        tamper((p) => (p.shopOrders[0].subtotalMinor = -5)),
        'invalid_payload',
      ],
      [
        'a fractional subtotal',
        tamper((p) => (p.shopOrders[0].subtotalMinor = 12.5)),
        'invalid_payload',
      ],
      [
        'all subtotals zero',
        tamper((p) => (p.shopOrders[0].subtotalMinor = 0)),
        'invalid_payload',
      ],
      [
        'a non-UUID shopId',
        tamper((p) => (p.shopOrders[0].shopId = 'shop-1')),
        'invalid_payload',
      ],
      [
        'a duplicate shopId',
        tamper(
          (p) =>
            (p.shopOrders = [
              p.shopOrders[0],
              { ...p.shopOrders[0], shopOrderId: uuidv4() },
            ]),
        ),
        'invalid_payload',
      ],
      [
        'a currency other than the sale',
        tamper((p) => (p.currency = 'USD')),
        'currency_mismatch',
      ],
      [
        'a field of the wrong type',
        tamper((p) => (p.totalMinor = 'lots')),
        'invalid_payload',
      ],
    ];
    for (const [name, event, reason] of cases) {
      const before = metric('ledger_consumer_dead_lettered_total', { reason });
      const outcome = await consumer.project([event]).then(
        () => 'resolved',
        (e) =>
          e instanceof PermanentError ? 'permanent' : `other:${String(e)}`,
      );
      expect([name, outcome]).toEqual([name, 'permanent']);
      expect([
        name,
        metric('ledger_consumer_dead_lettered_total', { reason }),
      ]).toEqual([name, before + 1]);
    }
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      0,
    );
    await settle(good());
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      1,
    );
  });

  it('S14 AS-20: a settlement before the sale is deferred on a 30/60/120/180/210 s chain, settles after the capture, or dead-letters after the 6th attempt', async () => {
    const shop = uuidv4();
    const input = captureInput({ amountMinor: 1050 });
    const deferredBefore = metric('ledger_settlement_deferred_total');
    const event = orderPaidEvent({
      orderId: input.orderId,
      shops: [{ shopId: shop, subtotalMinor: 1000 }],
    });
    const started = t.clock.now().getTime();

    await settle(event); // no sale yet: acknowledged and deferred
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      0,
    );
    expect(metric('ledger_settlement_deferred_total')).toBe(deferredBefore + 1);
    const queued = () =>
      sql<{
        payload: { attempt: number };
        runAt: Date;
        maxAttempts: number;
        idempotencyKey: string;
      }>(
        t.app,
        `SELECT payload, "runAt", "maxAttempts", "idempotencyKey" FROM "Job" WHERE type = 'ledger.settle-order' ORDER BY "runAt"`,
      );
    let rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.attempt).toBe(2);
    expect(rows[0].maxAttempts).toBe(1);
    expect(rows[0].idempotencyKey).toBe(`settle:${input.orderId}:2`);
    expect(rows[0].runAt.getTime() - started).toBe(30_000);

    // the sale arrives before the next attempt: the attempt settles with the AS-17 result
    await capture(input);
    await jobs.settleOrder({ paid: event.payload as never, attempt: 2 });
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      1,
    );
    expect(await balanceOf(t.app, `SHOP_${shop}`)).toBe(1000);

    // an order whose sale never comes: the chain of waits, then the dead letter on attempt 6
    const lonely = orderPaidEvent({
      orderId: uuidv4(),
      shops: [{ shopId: shop, subtotalMinor: 1000 }],
    });
    const deadBefore = metric('ledger_settlement_dead_lettered_total', {
      reason: 'sale_not_found',
    });
    await settle(lonely);
    const waits = [30_000, 60_000, 120_000, 180_000, 210_000];
    const at = t.clock.now().getTime();
    for (let attempt = 2; attempt <= 5; attempt++) {
      await jobs.settleOrder({ paid: lonely.payload as never, attempt });
      const next = (await queued()).find(
        (r) =>
          r.payload.attempt === attempt + 1 &&
          r.idempotencyKey ===
            `settle:${lonely.payload.orderId}:${attempt + 1}`,
      );
      expect(next).toBeDefined();
      expect(next!.runAt.getTime() - at).toBe(waits[attempt - 1]);
    }
    await expect(
      jobs.settleOrder({ paid: lonely.payload as never, attempt: 6 }),
    ).rejects.toThrow(/sale_not_found/);
    expect(
      metric('ledger_settlement_dead_lettered_total', {
        reason: 'sale_not_found',
      }),
    ).toBe(deadBefore + 1);
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      1,
    );
    rows = await queued();
    expect(rows.every((r) => r.maxAttempts === 1)).toBe(true);
  });

  it('S14 AS-21: a refund first means no shop is credited; settle then refund claws back; a race ends one way or the other', async () => {
    // (a) refund already posted
    const shopA = uuidv4();
    const a = captureInput({ amountMinor: 1050 });
    await capture(a);
    await refund({ paymentId: a.paymentId, amountMinor: 1050 });
    const skippedBefore = metric('ledger_settlement_skipped_total', {
      reason: 'refunded',
    });
    await settle(
      orderPaidEvent({
        orderId: a.orderId,
        shops: [{ shopId: shopA, subtotalMinor: 1000 }],
      }),
    );
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SETTLEMENT'`)).toBe(
      0,
    );
    expect(
      metric('ledger_settlement_skipped_total', { reason: 'refunded' }),
    ).toBe(skippedBefore + 1);
    expect(await balanceOf(t.app, `SHOP_${shopA}`)).toBe(0);

    // (c) the two racing, 50 times
    for (let round = 0; round < 50; round++) {
      const shop = uuidv4();
      const p = captureInput({ amountMinor: 1050 });
      await capture(p);
      await Promise.all([
        settle(
          orderPaidEvent({
            orderId: p.orderId,
            shops: [{ shopId: shop, subtotalMinor: 1000 }],
          }),
        ),
        refund({ paymentId: p.paymentId, amountMinor: 1050 }),
      ]);
      const net = await netPerAccount(p.paymentId);
      expect(net.every((r) => r.net === '0')).toBe(true);
      const settled = await count(
        t.app,
        'LedgerJournal',
        `"kind" = 'SETTLEMENT' AND "orderId" = :o`,
        { o: p.orderId },
      );
      const shopBalance = await balanceOf(t.app, `SHOP_${shop}`);
      expect(shopBalance).toBe(0); // credited and clawed back, or never credited
      if (settled === 0)
        expect(net.some((r) => r.accountId.startsWith('SHOP_'))).toBe(false);
    }
    await assertBooksHealthy(t.app);
  }, 180_000);
});
