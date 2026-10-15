import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { InvalidJobPayloadError } from '@app/infrastructure/jobs/job-errors';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import {
  assertBooksHealthy,
  balanceOf,
  count,
  newShopAccount,
  sql,
} from './testing/ledger-fixtures';
import { FakeProviderStatement } from './testing/fake-provider-statement';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  PROVIDER_STATEMENT,
  type BalanceReadModelStore,
} from './domain/ledger-ports';
import { LedgerModule } from './ledger.module';
import { LedgerProcessingModule } from './ledger-processing.module';
import { LedgerProjectorModule } from './ledger-projector.module';
import { LedgerJobs } from './infra/ledger.jobs';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import { BalanceProjector } from './infra/balance.projector';
import { PartitionMaintenanceService } from './application/partition-maintenance.service';
import { InvariantCheckService } from './application/invariant-check.service';
import { BalanceBackfillService } from './application/balance-backfill.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const contractMigration = require('../../../migrations/20261013100300-s14-ledger-contract.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expandMigration = require('../../../migrations/20261013100000-s14-ledger-expand.js');

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const fake = new FakeProviderStatement();
const DAY_MS = 86_400_000;
const midnight = (d: Date) =>
  new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

describe('Ledger: partitions, invariant checker, jobs and backfill', () => {
  let t: LedgerTestApp;
  let partitions: PartitionMaintenanceService;
  let checker: InvariantCheckService;
  let backfill: BalanceBackfillService;
  let jobs: LedgerJobs;
  let projector: BalanceProjector;
  let hot: BalanceReadModelStore;
  let durable: BalanceReadModelStore;

  beforeAll(async () => {
    t = await createLedgerApp({
      extraImports: [LedgerProcessingModule, LedgerProjectorModule],
      overrides: [{ provide: PROVIDER_STATEMENT, useValue: fake }],
    });
    partitions = t.app.get(PartitionMaintenanceService, { strict: false });
    checker = t.app.get(InvariantCheckService, { strict: false });
    backfill = t.app.get(BalanceBackfillService, { strict: false });
    jobs = t.app.get(LedgerJobs, { strict: false });
    projector = t.app.get(BalanceProjector, { strict: false });
    hot = t.app.get<BalanceReadModelStore>(BALANCE_HOT_STORE, {
      strict: false,
    });
    durable = t.app.get<BalanceReadModelStore>(BALANCE_DURABLE_STORE, {
      strict: false,
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    fake.reset();
    jest.restoreAllMocks();
  });

  const monthStart = (offset: number) => {
    const n = t.clock.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1));
  };
  const partitionName = (d: Date) =>
    `LedgerEntry_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const triggersOf = async (table: string) =>
    (
      await sql<{ tgname: string }>(
        t.app,
        `SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass(:t) AND NOT tgisinternal ORDER BY tgname`,
        { t: `"${table}"` },
      )
    ).map((r) => r.tgname);
  const tableExists = async (name: string) =>
    (
      await sql<{ r: string | null }>(
        t.app,
        `SELECT to_regclass(:t)::text AS r`,
        { t: `"${name}"` },
      )
    )[0].r !== null;
  const post = (
    lines: { accountId: string; amountMinor: number }[],
    reference = `t-${uuidv4()}`,
    kind: 'ADJUSTMENT' | 'AD_CHARGE' = 'ADJUSTMENT',
  ) =>
    t.inTx((tx) =>
      t.ledger.postJournal({ kind, reference, currency: 'EUR', lines }, tx),
    );
  const at = async <T>(date: Date, fn: () => Promise<T>) => {
    const keep = t.clock.now();
    t.clock.set(date);
    try {
      return await fn();
    } finally {
      t.clock.set(keep);
    }
  };
  const outbox = async (): Promise<EventEnvelope[]> =>
    (
      await sql<{ payload: EventEnvelope }>(
        t.app,
        `SELECT payload FROM "Outbox" WHERE "type" = 'ledger.journal_posted' ORDER BY "createdAt", id`,
      )
    ).map((r) => r.payload);

  it('S14 AS-60: partitions exist for the current month and the next three, each protected like the rest; a second run changes nothing', async () => {
    for (const offset of [2, 3])
      await t.sequelize.query(
        `DROP TABLE IF EXISTS "${partitionName(monthStart(offset))}"`,
      );
    expect(await tableExists(partitionName(monthStart(3)))).toBe(false);

    await partitions.ensure({ monthsAhead: 3 });
    for (const offset of [0, 1, 2, 3]) {
      const name = partitionName(monthStart(offset));
      expect([name, await tableExists(name)]).toEqual([name, true]);
      expect([name, await triggersOf(name)]).toEqual([
        name,
        ['ledger_append_only', 'ledger_balanced'],
      ]);
    }
    const oid = async () =>
      (
        await sql<{ oid: string }>(
          t.app,
          `SELECT oid::text FROM pg_class WHERE relname = :n`,
          { n: partitionName(monthStart(1)) },
        )
      )[0].oid;
    const before = await oid();
    await partitions.ensure({ monthsAhead: 3 }); // no-op, no error
    expect(await oid()).toBe(before); // an existing partition is skipped, not rebuilt
    await expect(jobs.ensurePartitions({})).resolves.toBe('ran');
  });

  it('S14 AS-61: a month without a partition still accepts a posting; maintenance moves it without changing a total; a boundary journal sits in one partition', async () => {
    const future = new Date(
      Date.UTC(
        monthStart(0).getUTCFullYear() + 1,
        monthStart(0).getUTCMonth(),
        15,
        10,
        0,
        0,
      ),
    );
    await t.sequelize.query(`DROP TABLE IF EXISTS "${partitionName(future)}"`);
    const [a, b] = [newShopAccount(), newShopAccount()];
    await at(future, () =>
      post([
        { accountId: a, amountMinor: -70 },
        { accountId: b, amountMinor: 70 },
      ]),
    );
    await at(future, () =>
      post([
        { accountId: a, amountMinor: -30 },
        { accountId: b, amountMinor: 30 },
      ]),
    );
    const totals = async () =>
      (
        await sql<{ n: string; s: string; abs: string }>(
          t.app,
          `SELECT count(*)::text n, sum(amount)::text s, sum(abs(amount))::text abs FROM "LedgerEntry"`,
        )
      )[0];
    const before = await totals();
    const where = async () =>
      (
        await sql<{ p: string }>(
          t.app,
          `SELECT DISTINCT tableoid::regclass::text AS p FROM "LedgerEntry"`,
        )
      ).map((r) => r.p);
    expect(await where()).toEqual(['"LedgerEntry_default"']);

    const alarms: string[] = [];
    const alarm = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void alarms.push(String(m)));
    await checker.run();
    alarm.mockRestore();
    expect(alarms.join('\n')).toMatch(/catch-all partition/);
    expect(metric('ledger_default_partition_rows')).toBe(4);

    await partitions.ensure({ monthsAhead: 14 });
    expect(await totals()).toEqual(before);
    expect(await where()).toEqual([`"${partitionName(future)}"`]);
    expect(await balanceOf(t.app, b)).toBe(100);
    expect(metric('ledger_default_partition_rows')).toBe(0);
    await assertBooksHealthy(t.app);

    // one postedAt, one partition, even at the last millisecond of a month
    await t.reset();
    const edge = new Date(
      Date.UTC(
        monthStart(0).getUTCFullYear(),
        monthStart(0).getUTCMonth() + 1,
        0,
        23,
        59,
        59,
        999,
      ),
    );
    await at(edge, () =>
      post([
        { accountId: a, amountMinor: -9 },
        { accountId: b, amountMinor: 4 },
        { accountId: newShopAccount(), amountMinor: 5 },
      ]),
    );
    const spread = await sql<{ at: string; p: string }>(
      t.app,
      `SELECT DISTINCT "createdAt"::text AS at, tableoid::regclass::text AS p FROM "LedgerEntry"`,
    );
    expect(spread).toHaveLength(1);
  });

  describe('invariant checker', () => {
    const yesterdayNoon = () =>
      new Date(midnight(t.clock.now()).getTime() - DAY_MS + 12 * 3_600_000);
    const projectAll = async () => {
      await projector.project(await outbox());
    };
    const violations = (check: string) =>
      metric('ledger_invariant_violations_total', { check });
    const seedHealthy = async () => {
      const [a, b] = [newShopAccount(), newShopAccount()];
      await at(yesterdayNoon(), async () => {
        await post([
          { accountId: a, amountMinor: -500 },
          { accountId: b, amountMinor: 500 },
        ]);
        await post([
          { accountId: 'PLATFORM_FEES', amountMinor: 20 },
          { accountId: a, amountMinor: -20 },
        ]);
      });
      await projectAll();
      return { a, b };
    };

    it('S14 AS-62: a healthy book passes every check and the job succeeds', async () => {
      await seedHealthy();
      const before = [
        'journal_balanced',
        'balance_matches_entries',
        'read_model_matches',
      ].map(violations);
      await expect(jobs.verifyInvariants({})).resolves.toBe('ran');
      expect(
        [
          'journal_balanced',
          'balance_matches_entries',
          'read_model_matches',
        ].map(violations),
      ).toEqual(before);
    });

    const checks = () => ({
      journal: violations('journal_balanced'),
      balance: violations('balance_matches_entries'),
      readModel: violations('read_model_matches'),
    });
    const captureErrors = () => {
      const lines: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((m: unknown) => void lines.push(String(m)));
      return { lines, stop: () => spy.mockRestore() };
    };

    it('S14 AS-62: an unbalanced journal raises journal_balanced only, names its id, and is not touched by the job', async () => {
      await seedHealthy();
      const partition = partitionName(yesterdayNoon());
      const bad = uuidv4();
      // written with the commit-time check disabled; the account's running balance follows its entries
      await t.sequelize.transaction(async (transaction) => {
        await t.sequelize.query(
          `ALTER TABLE "${partition}" DISABLE TRIGGER ledger_balanced`,
          { transaction },
        );
        await t.sequelize.query(
          `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount, "createdAt") VALUES (:j, 'ADJUSTMENT', 'PAYOUTS_SENT', 10, :at), (:j, 'ADJUSTMENT', 'PAYOUTS_SENT', -9, :at)`,
          { replacements: { j: bad, at: yesterdayNoon() }, transaction },
        );
        await t.sequelize.query(
          `ALTER TABLE "${partition}" ENABLE TRIGGER ledger_balanced`,
          { transaction },
        );
      });
      await sql(
        t.app,
        `INSERT INTO "AccountBalance" ("accountId","shard","currency","balanceMinor","version") VALUES ('PAYOUTS_SENT',0,'EUR',1,1) RETURNING 1`,
      );
      const log = captureErrors();
      const before = checks();
      await expect(jobs.verifyInvariants({})).resolves.toBe('ran');
      log.stop();
      expect(checks()).toEqual({ ...before, journal: before.journal + 1 });
      expect(log.lines.join('\n')).toContain(bad); // ids only, in the log
      expect(
        await count(t.app, 'LedgerEntry', `"journalId" = :j`, { j: bad }),
      ).toBe(2); // the job never edits the ledger
    });

    it('S14 AS-62: an edited running balance raises balance_matches_entries only and is never repaired by the job', async () => {
      const { a } = await seedHealthy();
      // the edit happened before the last projection, so the read model carries the same wrong value
      await sql(
        t.app,
        `UPDATE "AccountBalance" SET "balanceMinor" = "balanceMinor" + 7 WHERE "accountId" = :a RETURNING 1`,
        { a },
      );
      for (const store of [durable, hot])
        for (const line of await store.get(a))
          await store.overwrite({
            ...line,
            balanceMinor: line.balanceMinor + 7,
          });
      const log = captureErrors();
      const before = checks();
      await jobs.verifyInvariants({});
      log.stop();
      expect(checks()).toEqual({ ...before, balance: before.balance + 1 });
      expect(await balanceOf(t.app, a)).toBe(-520 + 7);
      expect(log.lines.join('\n')).toContain(a);
    });

    it('S14 AS-62: an edited read-model value raises read_model_matches only and is rewritten from the running balance', async () => {
      await seedHealthy();
      const dynamo = t.app.get(DynamoService);
      const [line] = await durable.get('PLATFORM_FEES');
      await dynamo.doc.send(
        new PutCommand({
          TableName: dynamo.table('LedgerBalanceView'),
          Item: {
            accountId: line.accountId,
            shardNo: line.shard,
            currency: 'EUR',
            balanceMinor: line.balanceMinor + 999,
            version: line.version,
            projectedAt: line.projectedAt.toISOString(),
          },
        }),
      );
      const before = checks();
      await jobs.verifyInvariants({});
      expect(checks()).toEqual({ ...before, readModel: before.readModel + 1 });
      expect((await durable.get('PLATFORM_FEES'))[0].balanceMinor).toBe(
        line.balanceMinor,
      );
      await jobs.verifyInvariants({}); // repaired: the next run finds nothing
      expect(checks()).toEqual({ ...before, readModel: before.readModel + 1 });
    });

    it('S14 AS-62: only the last two closed days are looked at', async () => {
      const old = new Date(
        midnight(t.clock.now()).getTime() - 5 * DAY_MS + 3_600_000,
      );
      // a month without a partition keeps its rows in the catch-all, which carries the same trigger
      const partition = (await tableExists(partitionName(old)))
        ? partitionName(old)
        : 'LedgerEntry_default';
      await t.sequelize.transaction(async (transaction) => {
        await t.sequelize.query(
          `ALTER TABLE "${partition}" DISABLE TRIGGER ledger_balanced`,
          { transaction },
        );
        await t.sequelize.query(
          `INSERT INTO "LedgerEntry" ("journalId", kind, "accountId", amount, "createdAt") VALUES (:j, 'ADJUSTMENT', 'PAYOUTS_SENT', 10, :at)`,
          { replacements: { j: uuidv4(), at: old }, transaction },
        );
        await t.sequelize.query(
          `ALTER TABLE "${partition}" ENABLE TRIGGER ledger_balanced`,
          { transaction },
        );
      });
      const before = violations('journal_balanced');
      await jobs.verifyInvariants({});
      expect(violations('journal_balanced')).toBe(before);
    });

    it('S14 AS-37: the projection lag gauge keeps growing while the projector is stopped', async () => {
      const [a, b] = [newShopAccount(), newShopAccount()];
      await post([
        { accountId: a, amountMinor: -5 },
        { accountId: b, amountMinor: 5 },
      ]);
      await projectAll();
      t.clock.advance(1_000);
      await post([
        { accountId: a, amountMinor: -5 },
        { accountId: b, amountMinor: 5 },
      ]); // never projected
      t.clock.advance(30_000);
      await checker.run();
      const first = metric('ledger_balance_projection_lag_seconds');
      expect(first).toBeGreaterThanOrEqual(30);
      t.clock.advance(60_000);
      await checker.run();
      expect(
        metric('ledger_balance_projection_lag_seconds'),
      ).toBeGreaterThanOrEqual(first + 60);
      await projectAll();
      await checker.run();
      expect(metric('ledger_balance_projection_lag_seconds')).toBe(0);
    });
  });

  it('S14 AS-63: each job runs once at a time and twice is the same as once; every schedule has three attempts and a registered payload contract', async () => {
    // two at once: the second sees the first and does not work
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const ensure = jest
      .spyOn(partitions, 'ensure')
      .mockImplementation(async () => {
        entered();
        await gate;
      });
    const first = jobs.ensurePartitions({});
    await inside;
    expect(await jobs.ensurePartitions({})).toBe('already_running');
    release();
    expect(await first).toBe('ran');
    expect(ensure).toHaveBeenCalledTimes(1);
    ensure.mockRestore();

    // sweep: twice in a window is once
    const [a, b] = [newShopAccount(), newShopAccount()];
    await post([
      { accountId: a, amountMinor: -5 },
      { accountId: b, amountMinor: 5 },
    ]);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t.inTx((tx) =>
          t.ledger.recordPaymentCaptured(
            {
              paymentId: uuidv4(),
              orderId: uuidv4(),
              paymentRef: `pi_${i}`,
              userId: uuidv4(),
              amountMinor: 250,
              currency: 'EUR',
            },
            tx,
          ),
        ),
      ),
    );
    await jobs.sweepHotAccounts({ window: '2026-10-12T14:00:00.000Z' });
    const sweeps = await count(t.app, 'LedgerJournal', `"kind" = 'SWEEP'`);
    await jobs.sweepHotAccounts({ window: '2026-10-12T14:00:00.000Z' });
    expect(await count(t.app, 'LedgerJournal', `"kind" = 'SWEEP'`)).toBe(
      sweeps,
    );
    await jobs.verifyInvariants({});
    await jobs.verifyInvariants({});

    // the schedules are registered at boot; the per-test cleanup empties the table, so register them again
    await jobs.onApplicationBootstrap();
    await t.app
      .get(ReconciliationJobs, { strict: false })
      .onApplicationBootstrap();
    const rows = await sql<{
      name: string;
      maxAttempts: number | null;
      jobType: string;
    }>(
      t.app,
      `SELECT name, "maxAttempts", "jobType" FROM "JobSchedule" WHERE name IN ('ledger.sweep-hot-accounts','ledger.ensure-partitions','ledger.verify-invariants','payments.reconcile-daily') ORDER BY name`,
    );
    expect(rows.map((r) => [r.name, r.maxAttempts])).toEqual([
      ['ledger.ensure-partitions', 3],
      ['ledger.sweep-hot-accounts', 3],
      ['ledger.verify-invariants', 3],
      ['payments.reconcile-daily', 3],
    ]);
    const queue = t.app.get(JobsService);
    for (const [type, payload] of [
      ['ledger.sweep-hot-accounts', { window: 'not-a-date' }],
      ['ledger.ensure-partitions', { monthsAhead: 13 }],
      ['ledger.ensure-partitions', { monthsAhead: 0 }],
      ['ledger.backfill-balances', { batch: 0 }],
      ['ledger.backfill-balances', { batch: 5001 }],
      ['ledger.verify-invariants', { surprise: true }],
    ] as const)
      await expect(
        queue.enqueue(type as never, payload as never),
      ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    const queued = await queue.enqueue('ledger.backfill-balances', {
      batch: 5000,
    });
    expect(queued.created).toBe(true);
    expect(
      (
        await sql<{ maxAttempts: number }>(
          t.app,
          `SELECT "maxAttempts" FROM "Job" WHERE id = :id`,
          { id: queued.id },
        )
      )[0].maxAttempts,
    ).toBe(3);
  });

  describe('backfill of the existing ledger (expand and contract)', () => {
    /** Journals in the old shape: lines with no header, no running balance, buyer accounts named after the user. */
    const seedLegacy = async (journals: number) => {
      const at = new Date(
        midnight(t.clock.now()).getTime() - 40 * DAY_MS,
      ).toISOString();
      await sql(
        t.app,
        `INSERT INTO "LedgerEntry" ("journalId", kind, "paymentId", "accountId", amount, "createdAt")
         SELECT j, 'SALE', NULL, acct, amt, :at::timestamptz + (n || ' seconds')::interval
           FROM (SELECT n, gen_random_uuid() AS j FROM generate_series(1, :journals) n) q
           CROSS JOIN LATERAL (VALUES
             ('MERCHANT_' || md5(q.j::text)::uuid::text, -100::bigint),
             ('MARKETPLACE_CLEARING', 90::bigint),
             ('PLATFORM_FEES', 6::bigint),
             ('SHOP_' || md5(q.j::text || 'shop')::uuid::text, 4::bigint)) AS v(acct, amt)
         RETURNING 1`,
        { at, journals },
      );
    };
    const sums = () =>
      sql<{
        accountId: string;
        shard: number;
        entries: string;
        balance: string | null;
      }>(
        t.app,
        `SELECT e."accountId", e."shard", e.total::text AS entries, b."balanceMinor"::text AS balance
           FROM (SELECT "accountId", "shard", "currency", sum(amount) AS total FROM "LedgerEntry" GROUP BY 1, 2, 3) e
           LEFT JOIN "AccountBalance" b ON b."accountId" = e."accountId" AND b."shard" = e."shard" AND b."currency" = e."currency"
          WHERE b."balanceMinor" IS DISTINCT FROM e.total`,
      );

    it('S14 AS-64: legacy rows get headers and balances in batches under live postings; an interrupted run resumes; a rerun changes nothing; the contract step waits for equality', async () => {
      await seedLegacy(3_000); // 12 000 entries: three batches of 5 000
      const live = Array.from({ length: 10 }, () => newShopAccount());
      const first = await backfill.run({ batch: 5_000, maxBatches: 1 });
      expect(first).toMatchObject({ batches: 1, finished: false });
      // postings continue between batches
      await Promise.all(
        live.map((acct) =>
          post([
            { accountId: acct, amountMinor: 25 },
            { accountId: 'PAYOUTS_SENT', amountMinor: -25 },
          ]),
        ),
      );

      const resumed = await backfill.run({ batch: 5_000 });
      expect(resumed.finished).toBe(true);
      expect(await count(t.app, 'LedgerJournal')).toBe(3_000 + 10);
      expect(await sums()).toEqual([]); // every running balance equals the sum of its entries
      expect(await balanceOf(t.app, 'PLATFORM_FEES')).toBe(3_000 * 6);
      expect(
        (
          await sql<{ n: string }>(
            t.app,
            `SELECT count(*)::text n FROM "AccountBalance" WHERE "accountId" LIKE 'MERCHANT\\_%'`,
          )
        )[0].n,
      ).toBe('3000');
      await assertBooksHealthy(t.app);

      // a rerun is a no-op
      const snapshot = JSON.stringify(
        await sql(
          t.app,
          `SELECT "accountId","shard","balanceMinor","version" FROM "AccountBalance" ORDER BY 1,2`,
        ),
      );
      expect((await backfill.run({ batch: 5_000 })).finished).toBe(true);
      expect(
        JSON.stringify(
          await sql(
            t.app,
            `SELECT "accountId","shard","balanceMinor","version" FROM "AccountBalance" ORDER BY 1,2`,
          ),
        ),
      ).toBe(snapshot);
      expect(await count(t.app, 'LedgerJournal')).toBe(3_010);

      // the read model is seeded and the checker is green
      expect((await durable.get('PLATFORM_FEES'))[0].balanceMinor).toBe(
        3_000 * 6,
      );
      await expect(jobs.verifyInvariants({})).resolves.toBe('ran');
    }, 180_000);

    it('S14 AS-64: a batch gives up on a held row within the 3 s lock limit and the cursor does not move', async () => {
      await seedLegacy(10);
      await backfill.run({ batch: 5, maxBatches: 1 }); // creates some balance rows
      const [row] = await sql<{ accountId: string }>(
        t.app,
        `SELECT "accountId" FROM "AccountBalance" WHERE "accountId" = 'PLATFORM_FEES' LIMIT 1`,
      );
      let release!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const ready = new Promise<void>((r) => (locked = r));
      const holder = t.sequelize.transaction(async (transaction) => {
        await t.sequelize.query(
          `SELECT 1 FROM "AccountBalance" WHERE "accountId" = :a FOR UPDATE`,
          { replacements: { a: row.accountId }, transaction },
        );
        locked();
        await hold;
      });
      await ready;
      const cursorBefore = JSON.stringify(
        await sql(t.app, `SELECT * FROM "LedgerBackfillCursor"`),
      );
      const started = Date.now();
      await expect(backfill.run({ batch: 5, maxBatches: 1 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(
        JSON.stringify(
          await sql(t.app, `SELECT * FROM "LedgerBackfillCursor"`),
        ),
      ).toBe(cursorBefore);
      release();
      await holder;
      expect((await backfill.run({ batch: 5 })).finished).toBe(true);
      expect(await sums()).toEqual([]);
    }, 60_000);

    it('S14 AS-64: the contract migration refuses until the legacy table equals the migrated rows by count and checksum, then drops it', async () => {
      await t.sequelize.query(`DROP TABLE IF EXISTS "LedgerEntry_legacy"`);
      await t.sequelize.query(
        `CREATE TABLE "LedgerEntry_legacy" ("id" UUID PRIMARY KEY, "paymentId" UUID NULL, "accountId" VARCHAR(255) NOT NULL, "amount" BIGINT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      const id = uuidv4();
      const j = uuidv4();
      await t.sequelize.query(
        `INSERT INTO "LedgerEntry_legacy" (id, "accountId", amount) VALUES (:id, 'A', 50)`,
        { replacements: { id } },
      );
      const qi = { sequelize: t.sequelize };
      await expect(contractMigration.up(qi)).rejects.toThrow(/legacy/i);
      expect(await tableExists('LedgerEntry_legacy')).toBe(true);

      // migrated with a different amount: still refused
      await t.sequelize.query(
        `INSERT INTO "LedgerEntry" (id, "journalId", kind, "accountId", amount) VALUES (:id, :j, 'SALE', 'A', 49), (uuidv7(), :j, 'SALE', 'B', -49)`,
        { replacements: { id, j } },
      );
      await expect(contractMigration.up(qi)).rejects.toThrow(/legacy/i);

      // the same row, migrated: equal count and checksum, the table is dropped
      await t.sequelize.query(`UPDATE "LedgerEntry_legacy" SET amount = 49`);
      await contractMigration.up(qi);
      expect(await tableExists('LedgerEntry_legacy')).toBe(false);
    });
  });

  it('S14 T120: the payout destination is copied into ProviderAccount and payouts read it, not Shop', async () => {
    const shopId = uuidv4();
    await sql(
      t.app,
      `INSERT INTO "Shop" (id, name, slug, "stripeAccountId", "createdAt", "updatedAt") VALUES (:id, 'S', :slug, 'acct_copy', now(), now()) RETURNING id`,
      { id: shopId, slug: `s-${shopId.slice(0, 8)}` },
    );
    await t.sequelize.query(`DELETE FROM "ProviderAccount"`);
    await t.sequelize.query(expandMigration.PROVIDER_ACCOUNT_COPY_SQL);
    expect(
      await sql(
        t.app,
        `SELECT "shopId", provider, "accountId" FROM "ProviderAccount"`,
      ),
    ).toEqual([{ shopId, provider: 'stripe', accountId: 'acct_copy' }]);
    const again = await t.sequelize.query(
      expandMigration.PROVIDER_ACCOUNT_COPY_SQL,
    ); // idempotent
    expect(again).toBeDefined();
    expect(await count(t.app, 'ProviderAccount')).toBe(1);

    // The weekly payout scenarios that used to follow (one per shop per week, success to the copied account,
    // reversal without an account) moved to S15: payout-run.e2e-spec.ts AS-01/AS-02 and payout-transfer.e2e-spec.ts
    // AS-17/AS-23.
    await assertBooksHealthy(t.app);
  });
});
