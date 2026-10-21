import { v4 as uuidv4 } from 'uuid';
import {
  accountingPeriodSchema,
  periodCloseAcceptedSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  DS1,
  ds1Messages,
  orderPaid,
  ledgerJournal,
  payoutPaid,
} from '@app/test/fixtures/statements';
import { CLOSE_FAULT } from './application/period-close.service';
import { STATEMENTS_CONFIG, type StatementsConfig } from './domain/config';
import { SNAPSHOT_REPOSITORY, type SnapshotRepository } from './domain/ports';
import { StatementsJobs } from './infra/statements.jobs';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const ctx = () => ({ signal: new AbortController().signal });

describe('Statements: period close and accounting periods', () => {
  let t: StatementsTestApp;
  let admin: TestUser;
  let shops: { a: string; b: string; c: string };
  let config: StatementsConfig;
  let jobs: StatementsJobs;
  const batchDefault = 10_000;

  beforeAll(async () => {
    t = await createStatementsApp();
    config = t.app.get(STATEMENTS_CONFIG, { strict: false });
    jobs = t.app.get(StatementsJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    config.snapshotBatch = batchDefault;
    t.app.get(CLOSE_FAULT, { strict: false }).after = undefined;
    jest.restoreAllMocks();
    t.clock.set(new Date('2026-04-01T00:30:00Z'));
    admin = await t.admin();
    shops = {
      a: (await t.shopWithOwner()).shopId,
      b: (await t.shopWithOwner()).shopId,
      c: (await t.shopWithOwner()).shopId,
    };
  });

  const seedDs1 = () => t.sales.deliver(...ds1Messages(shops));
  /** A session lives 5 minutes of the fake clock: moving the clock needs a fresh session. */
  const at = async (iso: string) => {
    t.clock.set(new Date(iso));
    admin = await t.admin();
  };
  const close = (
    month: string,
    who: TestUser | null = admin,
    key: string = uuidv4(),
  ) =>
    (who
      ? t.as(who).post(`/api/admin/accounting-periods/${month}/close`)
      : t.http().post(`/api/admin/accounting-periods/${month}/close`)
    ).set('Idempotency-Key', key);
  const period = (month: string) =>
    t.as(admin).get(`/api/admin/accounting-periods/${month}`);
  const snapshots = (month = '2026-03') =>
    t.sql<Record<string, string | number>>(
      `SELECT "shopId", gross::text, commission::text, net::text, lines, "payoutsPaidMinor"::text AS paid, "knowledgeCutoff"::text AS cutoff
         FROM "StatementSnapshot" WHERE month = :m ORDER BY "shopId"`,
      { m: `${month}-01` },
    );
  const count = async (sql: string) =>
    Number((await t.sql<{ n: string }>(sql))[0].n);
  const outboxCount = (type: string) =>
    count(`SELECT count(*)::text AS n FROM "Outbox" WHERE type = '${type}'`);
  const runs = () =>
    t.sql<{
      status: string;
      failureCode: string | null;
      details: unknown;
      batches: number;
      shops: number;
      runId: string;
      cutoff: string;
    }>(
      `SELECT "runId", status, "failureCode", details, "batchesWritten" AS batches, "shopsWritten" AS shops, "knowledgeCutoff"::text AS cutoff
         FROM "StatementPeriodRun" ORDER BY "startedAt"`,
    );
  const sums = (rows: Record<string, string | number>[]) =>
    Object.fromEntries(
      rows.map((r) => [
        r.shopId,
        [r.gross, r.commission, r.net, r.lines].map(Number),
      ]),
    );

  it('S16 AS-28: closing a ready month writes one snapshot per shop with sales, a period_closed event and history', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    const res = await close('2026-03');
    expect(res.status).toBe(202);
    const accepted = periodCloseAcceptedSchema.parse(res.body);
    expect(accepted).toMatchObject({ month: '2026-03', status: 'CLOSING' });
    expect((await period('2026-03')).body.status).toBe('CLOSING');

    await t.drainJobs();
    const view = accountingPeriodSchema.parse((await period('2026-03')).body);
    expect(view).toMatchObject({ status: 'CLOSED', shopCount: 2 });
    expect(Date.parse(view.knowledgeCutoff!)).toBe(
      Date.parse('2026-04-02T02:00:00Z'),
    );
    expect(view.lastRun).toMatchObject({
      runId: accepted.runId,
      status: 'COMPLETED',
      failureCode: null,
    });
    const rows = await snapshots();
    expect(sums(rows)).toEqual({
      [shops.a]: [30500, 3050, 27450, 3],
      [shops.b]: [4005, 401, 3604, 1],
    });
    expect(rows.some((r) => r.shopId === shops.c)).toBe(false);
    expect(await outboxCount('statements.period_closed')).toBe(1);
    const history = await t.sql<{
      fromStatus: string;
      toStatus: string;
      actor: string;
    }>(
      `SELECT "fromStatus", "toStatus", actor FROM "StatementPeriodHistory" ORDER BY "at", id`,
    );
    expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
      'OPEN>CLOSING',
      'CLOSING>CLOSED',
    ]);
    expect(history[0].actor).toBe(`admin:${admin.id}`);
    expect(
      metric('statements_period_close_total', { status: 'completed' }),
    ).toBeGreaterThan(0);
  });

  it('S16 AS-29: the scheduled close fired by two workers at once closes the previous month once', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    await Promise.all([jobs.closeMonth({}, ctx()), jobs.closeMonth({}, ctx())]);
    expect((await runs()).filter((r) => r.status === 'COMPLETED')).toHaveLength(
      1,
    );
    expect(await snapshots()).toHaveLength(2);
    expect(await outboxCount('statements.period_closed')).toBe(1);
    expect((await period('2026-03')).body.status).toBe('CLOSED');
  });

  it('S16 AS-29: a malformed or not-yet-past month is refused without effects', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    const enqueue = t.app.get(JobsService);
    await expect(
      enqueue.enqueue('statements.close-month', { month: '2026-13' } as never),
    ).rejects.toThrow();
    await expect(
      jobs.closeMonth({ month: '2026-04' }, ctx()),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(await runs()).toHaveLength(0);
    expect(
      await count(`SELECT count(*)::text AS n FROM "AccountingPeriod"`),
    ).toBe(0);
    expect(await snapshots()).toHaveLength(0);
  });

  it('S16 AS-30: delivering the close again after it finished changes nothing', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    const { runId } = (await close('2026-03')).body;
    await t.drainJobs();
    const before = {
      rows: await snapshots(),
      runs: await runs(),
      events: await outboxCount('statements.period_closed'),
    };
    const period0 = (await period('2026-03')).body;

    await jobs.closeMonth({ month: '2026-03', runId }, ctx());
    await jobs.closeMonth({}, ctx());
    expect(await snapshots()).toEqual(before.rows);
    expect(await runs()).toEqual(before.runs);
    expect(await outboxCount('statements.period_closed')).toBe(before.events);
    expect((await period('2026-03')).body).toEqual(period0);
  });

  it('S16 AS-31: the current or a future month cannot be closed and nothing is written', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    for (const month of ['2026-04', '2026-07']) {
      const res = await close(month);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('period_not_ended');
    }
    expect(
      await count(`SELECT count(*)::text AS n FROM "AccountingPeriod"`),
    ).toBe(0);
    expect(await runs()).toHaveLength(0);
  });

  it('S16 AS-32: a stream that is behind makes the close wait with its name and watermark, and it succeeds once caught up', async () => {
    await t.sales.deliver(
      orderPaid({
        orderId: DS1.o1,
        paidAt: '2026-03-31T23:40:00Z',
        lines: [{ lineId: DS1.l1, shopId: shops.a, unitPriceMinor: 10000 }],
      }),
    );
    await at('2026-04-02T02:00:00Z');
    t.lag.set('orders', false);
    const blocked = await close('2026-03');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('period_not_ready');
    expect(blocked.body.details).toMatchObject({
      stream: 'orders',
      watermark: '2026-03-31T23:40:00.000Z',
    });
    expect(await snapshots()).toHaveLength(0);
    expect(await runs()).toHaveLength(0);

    await t.sales.deliver(
      orderPaid({
        orderId: DS1.o2,
        paidAt: '2026-03-31T23:50:00Z',
        lines: [{ lineId: DS1.l2, shopId: shops.a, unitPriceMinor: 20000 }],
      }),
    );
    t.lag.set('orders', true);
    expect((await close('2026-03')).status).toBe(202);
    await t.drainJobs();
    expect(sums(await snapshots())).toEqual({
      [shops.a]: [30000, 3000, 27000, 2],
    });
  });

  it('S16 AS-32: the scheduled close waits and retries later instead of closing early', async () => {
    await t.sales.deliver(
      orderPaid({
        paidAt: '2026-03-31T23:40:00Z',
        lines: [{ shopId: shops.a, unitPriceMinor: 100 }],
      }),
    );
    await at('2026-04-02T02:00:00Z');
    t.lag.set('orders', false);
    await jobs.closeMonth({}, ctx());
    expect(await snapshots()).toHaveLength(0);
    expect((await period('2026-03')).body.status).toBe('OPEN');
    const [retry] = await t.sql<{ type: string; runAt: string }>(
      `SELECT type, "runAt"::text AS "runAt" FROM "Job" WHERE type = 'statements.close-month' AND status = 'QUEUED'`,
    );
    expect(retry.type).toBe('statements.close-month');
    expect(Date.parse(retry.runAt)).toBeGreaterThan(t.clock.now().getTime());
  });

  it('S16 AS-33: months close in order: a previous open month blocks, and the scheduled run catches up oldest first', async () => {
    await t.sales.deliver(
      orderPaid({
        paidAt: '2026-02-10T12:00:00Z',
        lines: [{ shopId: shops.a, unitPriceMinor: 5000 }],
      }),
      ...ds1Messages(shops),
    );
    await at('2026-04-02T02:00:00Z');
    const blocked = await close('2026-03');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('previous_period_open');
    expect(blocked.body.details).toEqual({ month: '2026-02' });

    await jobs.closeMonth({}, ctx());
    const done = await t.sql<{ month: string; status: string }>(
      `SELECT to_char(month, 'YYYY-MM') AS month, status FROM "AccountingPeriod" ORDER BY month`,
    );
    expect(done).toEqual([
      { month: '2026-02', status: 'CLOSED' },
      { month: '2026-03', status: 'CLOSED' },
    ]);
    const history = await t.sql<{ month: string; toStatus: string }>(
      `SELECT to_char(month, 'YYYY-MM') AS month, "toStatus" FROM "StatementPeriodHistory" WHERE "toStatus" = 'CLOSED' ORDER BY "at", id`,
    );
    expect(history.map((h) => h.month)).toEqual(['2026-02', '2026-03']);
    expect(new Set((await runs()).map((r) => r.runId)).size).toBe(2);
  });

  it('S16 AS-34: a closed month, a month being closed, a reopen route and a privileged reopen are all refused', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    expect((await close('2026-03')).status).toBe(202);
    const closing = await close('2026-03');
    expect(closing.status).toBe(409);
    expect(closing.body.code).toBe('period_closing');

    await t.drainJobs();
    const closed = await close('2026-03');
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('period_closed');
    expect(
      (
        await t
          .as(admin)
          .post('/api/admin/accounting-periods/2026-03/reopen')
          .set('Idempotency-Key', uuidv4())
      ).status,
    ).toBe(404);
    await expect(
      t.sequelize.query(
        `UPDATE "AccountingPeriod" SET status = 'OPEN' WHERE month = '2026-03-01'`,
      ),
    ).rejects.toThrow(/statements_immutable/);
    expect((await period('2026-03')).body.status).toBe('CLOSED');
  });

  it('S16 AS-35: two admins closing the same month at once give one 202, one 409 and one run', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    const other = await t.admin();
    const [one, two] = await Promise.all([
      close('2026-03'),
      close('2026-03', other),
    ]);
    expect([one.status, two.status].sort()).toEqual([202, 409]);
    expect([one, two].find((r) => r.status === 409)!.body.code).toBe(
      'period_closing',
    );
    expect(await runs()).toHaveLength(1);
    await t.drainJobs();
    expect(await snapshots()).toHaveLength(2);
    expect(await outboxCount('statements.period_closed')).toBe(1);
  });

  describe('S16 AS-36 a crash is resumable and deterministic', () => {
    const sales = async () => {
      const five = [] as string[];
      for (let i = 0; i < 5; i++) five.push((await t.shopWithOwner()).shopId);
      await t.sales.deliver(
        ...five.map((shopId, i) =>
          orderPaid({
            paidAt: '2026-03-10T10:00:00Z',
            lines: [{ shopId, unitPriceMinor: (i + 1) * 1000 }],
          }),
        ),
      );
      return five;
    };

    it('S16 AS-36: killed after two batches the month stays CLOSING and unpublished, and the resumed run equals an uninterrupted one', async () => {
      const five = await sales();
      config.snapshotBatch = 2;
      await at('2026-04-02T02:00:00Z');
      const { runId } = (await close('2026-03')).body;
      t.app.get(CLOSE_FAULT, { strict: false }).after = (batches: number) => {
        if (batches === 2) throw new Error('worker killed');
      };
      await expect(
        jobs.closeMonth({ month: '2026-03', runId }, ctx()),
      ).rejects.toThrow('worker killed');

      expect((await period('2026-03')).body.status).toBe('CLOSING');
      expect(await snapshots()).toHaveLength(4); // written, but invisible while CLOSING
      const live = await t
        .as(await t.member(five[0], 'OWNER'))
        .get(`/api/shops/${five[0]}/statements/2026-03`);
      expect(live.body).toMatchObject({ source: 'live', status: 'CLOSING' });
      expect(live.body.own.grossMinor).toBe(1000);
      const cutoff = (await runs())[0].cutoff;

      t.app.get(CLOSE_FAULT, { strict: false }).after = undefined;
      await at('2026-04-02T05:00:00Z'); // the lease expired hours later: the cutoff must not move
      await jobs.closeMonth({ month: '2026-03', runId }, ctx());
      expect((await period('2026-03')).body.status).toBe('CLOSED');
      const rows = await snapshots();
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.cutoff)).size).toBe(1);
      expect((await runs())[0].cutoff).toBe(cutoff);
      const expected = Object.fromEntries(
        five.map((id, i) => {
          const gross = (i + 1) * 1000;
          const commission = Math.floor((gross * 1000 + 5000) / 10000);
          return [id, [gross, commission, gross - commission, 1]];
        }),
      );
      expect(sums(rows)).toEqual(expected);
      expect(await outboxCount('statements.period_closed')).toBe(1);
    });
  });

  it('S16 AS-37: snapshots, adjustments and closed periods cannot be updated or deleted, and closing again replaces nothing', async () => {
    await seedDs1();
    await at('2026-04-02T02:00:00Z');
    await close('2026-03');
    await t.drainJobs();
    const before = await snapshots();
    await expect(
      t.sequelize.query(`UPDATE "StatementSnapshot" SET gross = 1`),
    ).rejects.toThrow(/statements_immutable/);
    await expect(
      t.sequelize.query(`DELETE FROM "StatementSnapshot"`),
    ).rejects.toThrow(/statements_immutable/);
    await expect(
      t.sequelize.query(`DELETE FROM "AccountingPeriod"`),
    ).rejects.toThrow(/statements_immutable/);
    await expect(
      t.sequelize.query(`UPDATE "AccountingPeriod" SET "shopCount" = 99`),
    ).rejects.toThrow(/statements_immutable/);
    await t.sequelize.query(
      `INSERT INTO "StatementAdjustment" ("shopId", "bookedMonth", "refersToMonth", "commissionDelta", "commissionDeltaMinor", reason, "causeKind", "causeRef")
       VALUES (:shop, '2026-04-01', '2026-03-01', -5, -5, 'tamper test', 'rate_change', 'x')`,
      { replacements: { shop: shops.a } },
    );
    await expect(
      t.sequelize.query(
        `UPDATE "StatementAdjustment" SET "commissionDeltaMinor" = 0`,
      ),
    ).rejects.toThrow(/statements_immutable/);
    await expect(
      t.sequelize.query(`DELETE FROM "StatementAdjustment"`),
    ).rejects.toThrow(/statements_immutable/);
    expect(await snapshots()).toEqual(before);
    await jobs.closeMonth({ month: '2026-03' }, ctx());
    expect(await snapshots()).toEqual(before);
  });

  it('S16 AS-38: a line no rate resolves fails the close, leaves the month open and nothing visible', async () => {
    await seedDs1();
    await t.sequelize.query(`DELETE FROM "CommissionRate"`); // privileged: the default rate disappears
    await at('2026-04-02T02:00:00Z');
    const accepted = (await close('2026-03')).body;
    await t.drainJobs();
    const [run] = await runs();
    expect(run).toMatchObject({
      status: 'FAILED',
      failureCode: 'unpriced_lines',
      details: { count: 4 },
    });
    expect(run.runId).toBe(accepted.runId);
    const view = (await period('2026-03')).body;
    expect(view.status).toBe('OPEN');
    expect(view.lastRun).toMatchObject({
      status: 'FAILED',
      failureCode: 'unpriced_lines',
    });
    expect(await snapshots()).toHaveLength(0);
    expect(metric('statements_unpriced_lines_total')).toBeGreaterThanOrEqual(4);
    expect(
      metric('statements_period_close_total', { status: 'failed' }),
    ).toBeGreaterThan(0);
  });

  it('S16 AS-39: 25 shops with a batch of 10 are written in three batches and the month closes only after all are counted', async () => {
    const many: string[] = (
      await Promise.all(Array.from({ length: 25 }, () => t.shopWithOwner()))
    ).map((made) => made.shopId); // together (was one by one)
    await t.sales.deliver(
      ...many.map((shopId) =>
        orderPaid({
          paidAt: '2026-03-10T10:00:00Z',
          lines: [{ shopId, unitPriceMinor: 1000 }],
        }),
      ),
    );
    config.snapshotBatch = 10;
    const sizes: number[] = [];
    const repo = t.app.get<SnapshotRepository>(SNAPSHOT_REPOSITORY, {
      strict: false,
    });
    const write = repo.writeBatch.bind(repo);
    jest
      .spyOn(repo, 'writeBatch')
      .mockImplementation(async (month, rows, cutoff, runId, computedAt) => {
        sizes.push(rows.length);
        return write(month, rows, cutoff, runId, computedAt);
      });
    await at('2026-04-02T02:00:00Z');
    await close('2026-03');
    await t.drainJobs();
    expect(sizes).toEqual([10, 10, 5]);
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'COMPLETED', batches: 3, shops: 25 });
    expect((await period('2026-03')).body).toMatchObject({
      status: 'CLOSED',
      shopCount: 25,
    });
    expect(await snapshots()).toHaveLength(25);
    void ledgerJournal;
    void payoutPaid;
  });
});
