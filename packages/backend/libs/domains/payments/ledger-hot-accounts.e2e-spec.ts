import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  assertBooksHealthy,
  count,
  newShopAccount,
  orderPaidEvent,
  sql,
} from './testing/ledger-fixtures';
import { SettlementService } from './application/settlement.service';
import { LedgerProcessingModule } from './ledger-processing.module';
import { LedgerJobs } from './infra/ledger.jobs';
import { HotAccountSweepService } from './application/hot-account-sweep.service';

const HOT = ['MARKETPLACE_CLEARING', 'PLATFORM_FEES', 'PROVIDER_CLEARING'];

describe('Ledger: hot-account sharding, sweep and lock order', () => {
  let t: LedgerTestApp;
  let sweep: HotAccountSweepService;
  let jobs: LedgerJobs;
  let settlement: SettlementService;

  beforeAll(async () => {
    t = await createLedgerApp({ extraImports: [LedgerProcessingModule] });
    sweep = t.app.get(HotAccountSweepService, { strict: false });
    settlement = t.app.get(SettlementService, { strict: false });
    jobs = t.app.get(LedgerJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** A sale and its settlement (10 %: 25 of every 250 reach `PLATFORM_FEES`); the result is the sale's. */
  const capture = async (amountMinor = 250) => {
    const orderId = uuidv4();
    const sale = await t.inTx((tx) =>
      t.ledger.recordPaymentCaptured(
        {
          paymentId: uuidv4(),
          orderId,
          paymentRef: `pi_${uuidv4().slice(0, 8)}`,
          userId: uuidv4(),
          amountMinor,
          currency: 'EUR',
        },
        tx,
      ),
    );
    await settlement.settle(
      orderPaidEvent({
        orderId,
        shops: [{ shopId: uuidv4(), subtotalMinor: amountMinor }],
      }).payload as never,
    );
    return sale;
  };
  const logical = async (accountId: string) =>
    (
      await t.ledger.getBalances({ accountIds: [accountId], currency: 'EUR' })
    ).get(accountId)!.balanceMinor;
  const shardRows = (accountId: string) =>
    sql<{ shard: number; balance: string; version: string }>(
      t.app,
      `SELECT "shard", "balanceMinor"::text AS balance, "version"::text AS version FROM "AccountBalance" WHERE "accountId" = :accountId ORDER BY "shard"`,
      { accountId },
    );

  it('S14 AS-22: 200 captures at once (5 times) give no deadlock or timeout and exact balances across more than 8 shards', async () => {
    for (let round = 0; round < 5; round++) {
      await t.reset();
      const waits =
        MetricsRegistry.histogramValue('ledger_lock_wait_seconds', {
          accountClass: 'PLATFORM_FEES',
        })?.count ?? 0;
      const results = await Promise.all(
        Array.from({ length: 200 }, () => capture(250)),
      );
      expect(results.every((r) => r.created)).toBe(true);
      expect(await logical('PLATFORM_FEES')).toBe(5_000);
      expect(await logical('PROVIDER_CLEARING')).toBe(-50_000);
      expect(await logical('MARKETPLACE_CLEARING')).toBe(0); // in with the sale, out with the settlement
      for (const account of HOT) {
        const rows = await shardRows(account);
        expect(
          rows.filter((r) => Number(r.balance) !== 0).length,
        ).toBeGreaterThan(8);
        // one touch per posting: the versions across the shards add up to the number of postings (clearing: sale and settlement)
        expect(rows.reduce((s, r) => s + Number(r.version), 0)).toBe(
          account === 'MARKETPLACE_CLEARING' ? 400 : 200,
        );
      }
      expect(
        MetricsRegistry.histogramValue('ledger_lock_wait_seconds', {
          accountClass: 'PLATFORM_FEES',
        })!.count,
      ).toBeGreaterThan(waits);
      await assertBooksHealthy(t.app);
    }
  }, 180_000);

  it('S14 AS-23: raising the shard count from 32 to 64 keeps the logical balances correct', async () => {
    await Promise.all(Array.from({ length: 60 }, () => capture(250)));
    const config = t.app.get(ApiConfigService);
    const original = config.get.bind(config);
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'ledger_shards' ? 64 : original(key as never)) as never);
    try {
      await Promise.all(Array.from({ length: 60 }, () => capture(250)));
    } finally {
      spy.mockRestore();
    }
    expect(await logical('PLATFORM_FEES')).toBe(3_000);
    expect(await logical('PROVIDER_CLEARING')).toBe(-30_000);
    const usedHigh = (await shardRows('PLATFORM_FEES')).some(
      (r) => r.shard >= 32,
    );
    expect(usedHigh).toBe(true);
    await assertBooksHealthy(t.app);
  }, 60_000);

  it('S14 AS-24: the sweep moves each hot account into shard 0 in one deterministic journal, leaves empty shards alone, is idempotent and safe under load', async () => {
    await Promise.all(Array.from({ length: 40 }, () => capture(250)));
    const before = Object.fromEntries(
      await Promise.all(HOT.map(async (a) => [a, await logical(a)] as const)),
    );
    const window = '2026-10-12T14:00:00.000Z';

    const first = await sweep.sweepAll(window);
    expect(first.map((r) => r.accountId).sort()).toEqual(HOT);
    expect(first.every((r) => r.created && r.journalId)).toBe(true);
    for (const account of HOT) {
      const rows = await shardRows(account);
      expect(
        rows.filter((r) => r.shard > 0).every((r) => Number(r.balance) === 0),
      ).toBe(true);
      expect(await logical(account)).toBe(before[account]);
      // A row for shard 0 exists only if a posting drew shard 0 or the sweep had something to credit to it. An account whose
      // shards net to zero (MARKETPLACE_CLEARING: in with the sale, out with the settlement) gets no credit line, so with
      // no random draw on shard 0 it has no row; no row means balance 0. Either way shard 0 must hold the logical balance.
      expect(Number(rows.find((r) => r.shard === 0)?.balance ?? 0)).toBe(
        before[account],
      );
    }
    const [journal] = await sql<{
      kind: string;
      reference: string;
      lines: string;
    }>(
      t.app,
      `SELECT j.kind, j.reference, (SELECT count(*)::text FROM "LedgerEntry" e WHERE e."journalId" = j.id) AS lines
         FROM "LedgerJournal" j WHERE j.reference = :r`,
      { r: `PLATFORM_FEES:${window}` },
    );
    expect(journal.kind).toBe('SWEEP');
    // only the non-empty shards plus shard 0 are in the journal
    const used = (await shardRows('PLATFORM_FEES')).length;
    expect(Number(journal.lines)).toBeLessThanOrEqual(used);
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SWEEP'`)).toBe(3);

    const again = await sweep.sweepAll(window);
    expect(again.every((r) => !r.created)).toBe(true);
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SWEEP'`)).toBe(3);

    // 100 captures in flight while the next window sweeps: exact totals, no deadlock
    const inFlight = Array.from({ length: 100 }, () => capture(250));
    const sweeping = sweep.sweepAll('2026-10-12T15:00:00.000Z');
    await Promise.all([...inFlight, sweeping]);
    expect(await logical('PLATFORM_FEES')).toBe(
      before.PLATFORM_FEES + 100 * 25,
    );
    expect(await logical('PROVIDER_CLEARING')).toBe(
      before.PROVIDER_CLEARING - 100 * 250,
    );
    await assertBooksHealthy(t.app);
  }, 120_000);

  it('S14 AS-24: the hourly job runs the sweep for the clock hour and passes the window through', async () => {
    t.clock.set(new Date('2026-10-12T09:41:07.000Z'));
    await Promise.all(Array.from({ length: 20 }, () => capture(250)));
    await jobs.sweepHotAccounts({});
    expect(
      await count(t.app, 'LedgerJournal', `"reference" = :r`, {
        r: 'PLATFORM_FEES:2026-10-12T09:00:00.000Z',
      }),
    ).toBe(1);
    await jobs.sweepHotAccounts({ window: '2026-10-12T09:00:00.000Z' });
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SWEEP'`)).toBe(3);
  });

  it('S14 AS-25: 100 pairs of postings naming the same two accounts in opposite order all succeed with exact balances', async () => {
    const [x, y] = [newShopAccount(), newShopAccount()];
    const post = (i: number, flip: boolean) =>
      t.inTx((tx) =>
        t.ledger.postJournal(
          {
            kind: 'ADJUSTMENT',
            reference: `pair-${i}-${flip ? 'b' : 'a'}`,
            currency: 'EUR',
            lines: flip
              ? [
                  { accountId: y, amountMinor: -3 },
                  { accountId: x, amountMinor: 3 },
                ]
              : [
                  { accountId: x, amountMinor: -2 },
                  { accountId: y, amountMinor: 2 },
                ],
          },
          tx,
        ),
      );
    const settled = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => [
        post(i, false),
        post(i, true),
      ]).flat(),
    );
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    expect(await logical(x)).toBe(100 * (3 - 2));
    expect(await logical(y)).toBe(100 * (2 - 3));
    await assertBooksHealthy(t.app);
  }, 120_000);

  it('S14 AS-27: a hot account reads as one logical account and no output shows a shard', async () => {
    await Promise.all(Array.from({ length: 30 }, () => capture(250)));
    const shardSum = (await shardRows('PLATFORM_FEES')).reduce(
      (s, r) => s + Number(r.balance),
      0,
    );
    const got = await t.ledger.getBalances({
      accountIds: ['PLATFORM_FEES'],
      currency: 'EUR',
    });
    expect(got.get('PLATFORM_FEES')!.balanceMinor).toBe(shardSum);
    expect(Object.keys(got.get('PLATFORM_FEES')!).sort()).toEqual([
      'asOf',
      'balanceMinor',
    ]);

    // a refused posting, and the logs of the run, say nothing about a shard
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((m: unknown) => void lines.push(String(m))),
    );
    let message = '';
    try {
      await t.inTx((tx) =>
        t.ledger.postJournal(
          {
            kind: 'ADJUSTMENT',
            reference: 'bad',
            currency: 'EUR',
            lines: [
              { accountId: 'PLATFORM_FEES#07', amountMinor: -5 },
              { accountId: newShopAccount(), amountMinor: 5 },
            ],
          },
          tx,
        ),
      );
    } catch (e) {
      message =
        JSON.stringify(
          (e as { toJSONPublic?: () => unknown }).toJSONPublic?.() ?? {},
        ) + String((e as Error).message);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(message).not.toMatch(/shard/i);
    expect(lines.join('\n')).not.toMatch(/shard/i);
  });
});
