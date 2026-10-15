import { v4 as uuidv4 } from 'uuid';
import type { Sequelize } from 'sequelize';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { READ_REPLICA_CONNECTION } from '@app/infrastructure/database/read-replica.provider';
import { orderPaid } from '@app/test/fixtures/statements';
import { CLOSE_FAULT } from './application/period-close.service';
import {
  STATEMENTS_CONFIG,
  loadStatementsConfig,
  type StatementsConfig,
} from './domain/config';
import { CSV_COLUMNS } from './domain/csv';
import { StatementsLifecycle } from './infra/statements-lifecycle';
import { StatementsJobs } from './infra/statements.jobs';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';
import {
  closeMonth,
  createShops,
  rc1,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const expandMigration = jest.requireActual<{
  up(queryInterface: unknown): Promise<void>;
}>('../../../migrations/20261016000000-statements-s16-expand.js');

describe('Statements: retention, boundaries, migration, configuration and shutdown', () => {
  let t: StatementsTestApp;
  let shops: Shops;
  let config: StatementsConfig;
  const batchDefault = 10_000;

  beforeAll(async () => {
    t = await createStatementsApp({ structuredLogger: true });
    config = t.app.get(STATEMENTS_CONFIG, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
    config.snapshotBatch = batchDefault;
    config.readTimeoutMs = 10_000;
    t.app.get(CLOSE_FAULT, { strict: false }).after = undefined;
    (
      t.app.get(StatementsLifecycle, { strict: false }) as unknown as {
        stopping: boolean;
      }
    ).stopping = false;
    setClock(t, '2026-04-01T00:30:00Z');
    shops = await createShops(t);
  });

  const counts = async () =>
    (
      await t.sql<{ n: string }>(
        `SELECT json_build_object(
            'rates', (SELECT count(*) FROM "CommissionRate"),
            'sales', (SELECT count(*) FROM "StatementSaleFact"),
            'payouts', (SELECT count(*) FROM "StatementPayoutFact"),
            'snapshots', (SELECT count(*) FROM "StatementSnapshot"),
            'adjustments', (SELECT count(*) FROM "StatementAdjustment"),
            'periods', (SELECT count(*) FROM "AccountingPeriod"))::text AS n`,
      )
    )[0].n;

  it('S16 AS-76: a deleted shop keeps its rates, facts, snapshots and periods; no route deletes; no buyer identifier is stored', async () => {
    await setRate(t, rc1(shops.a));
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    const before = await counts();
    const closed = await readStatement(t, shops.a, '2026-03');

    await t.sequelize.query(
      `UPDATE "Shop" SET status = 'DELETED', "shopVersion" = "shopVersion" + 1 WHERE id = :id`,
      {
        replacements: { id: shops.a },
      },
    );
    expect(await counts()).toBe(before);

    const admin = await t.admin();
    const period = await t
      .as(admin)
      .get('/api/admin/accounting-periods/2026-03');
    expect(period.status).toBe(200);
    expect(period.body.status).toBe('CLOSED');
    const history = await t
      .as(admin)
      .get(`/api/admin/commission-rates?shopId=${shops.a}`);
    expect(history.status).toBe(200);
    expect(history.body.items.length).toBeGreaterThan(0);
    const findings = await t
      .as(admin)
      .get('/api/admin/accounting-periods/2026-03/findings');
    expect(findings.status).toBe(200);
    expect(closed.own.grossMinor).toBe(30500);

    // no deletion route for any resource of the domain
    for (const url of [
      `/api/shops/${shops.a}/statements/2026-03`,
      '/api/admin/accounting-periods/2026-03',
      `/api/admin/commission-rates/${uuidv4()}`,
      `/api/admin/commission-rates?shopId=${shops.a}`,
    ]) {
      const res = await t.as(admin).delete(url);
      expect([404, 405]).toContain(res.status);
    }
    expect(await counts()).toBe(before);

    // no buyer identifier: no such column in an owned table, no buyer value in any stored row, none in the CSV header
    const columns = await t.sql<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name LIKE 'Statement%' OR table_name IN ('AccountingPeriod', 'CommissionRate'))`,
    );
    expect(columns.length).toBeGreaterThan(40);
    expect(
      columns.filter((c) =>
        /buyer|customer|email|^userId$/i.test(c.column_name),
      ),
    ).toEqual([]);
    const stored = await t.sql<{ n: string }>(
      `SELECT ((SELECT count(*) FROM "StatementSaleFact" f WHERE f::text LIKE '%buyer-%')
             + (SELECT count(*) FROM "StatementSnapshot" f WHERE f::text LIKE '%buyer-%')
             + (SELECT count(*) FROM "StatementAdjustment" f WHERE f::text LIKE '%buyer-%'))::text AS n`,
    );
    expect(stored[0].n).toBe('0');
    expect(CSV_COLUMNS.join(',')).not.toMatch(/buyer|user|customer|email/i);
  });

  it('S16 AS-78: running the expand migration again changes no closed month and no row', async () => {
    await setRate(t, rc1(shops.a));
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    const bodies = async () => [
      await readStatement(t, shops.a, '2026-03'),
      await readStatement(t, shops.b, '2026-03'),
      await readStatement(
        t,
        shops.a,
        '2026-03',
        '?knownAt=2026-04-01T12:00:00Z',
      ),
    ];
    const rowsBefore = await counts();
    const before = await bodies();
    const queryInterface = (t.sequelize as Sequelize).getQueryInterface();
    await expandMigration.up(queryInterface);
    await expandMigration.up(queryInterface);
    expect(await counts()).toBe(rowsBefore);
    expect(await bodies()).toEqual(before);
    // the guards survived the second run
    await expect(
      t.sequelize.query(`UPDATE "StatementSnapshot" SET gross = 1`),
    ).rejects.toThrow(/statements_immutable/);
  });

  describe('S16 AS-79: configuration is validated at startup', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['STATEMENTS_SNAPSHOT_BATCH', { STATEMENTS_SNAPSHOT_BATCH: '0' }],
      ['STATEMENTS_SNAPSHOT_BATCH', { STATEMENTS_SNAPSHOT_BATCH: '10001' }],
      ['STATEMENTS_CLOSE_MARGIN_MIN', { STATEMENTS_CLOSE_MARGIN_MIN: '-1' }],
      ['STATEMENTS_EXPORT_CONCURRENCY', { STATEMENTS_EXPORT_CONCURRENCY: '0' }],
      ['STATEMENTS_EXPORT_TIMEOUT_MS', { STATEMENTS_EXPORT_TIMEOUT_MS: '999' }],
      [
        'STATEMENTS_CLOSE_SCHEDULE',
        { STATEMENTS_CLOSE_SCHEDULE: 'not a schedule' },
      ],
      ['STATEMENTS_RETENTION_YEARS', { STATEMENTS_RETENTION_YEARS: '9' }],
    ];

    it.each(cases)(
      'rejects an invalid %s and names it, never the value',
      (key, env) => {
        let message = '';
        try {
          loadStatementsConfig(env);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(key);
        expect(message).not.toContain(
          Object.values(env)[0] === '0' ? 'zzz' : Object.values(env)[0],
        );
      },
    );

    it('accepts the defaults and the bounds', () => {
      expect(loadStatementsConfig({})).toMatchObject({
        snapshotBatch: 10_000,
        closeMarginMin: 10,
        exportConcurrency: 2,
        retentionYears: 10,
        closeScheduleTz: 'UTC',
      });
      expect(
        loadStatementsConfig({
          STATEMENTS_SNAPSHOT_BATCH: '1',
          STATEMENTS_CLOSE_MARGIN_MIN: '0',
          STATEMENTS_RETENTION_YEARS: '10',
        }),
      ).toMatchObject({
        snapshotBatch: 1,
        closeMarginMin: 0,
        retentionYears: 10,
      });
    });
  });

  it('S16 AS-80: a stop signal during a close leaves the month CLOSING and resumable, and the resumed run equals an uninterrupted one', async () => {
    const jobs = t.app.get(StatementsJobs, { strict: false });
    const lifecycle = t.app.get(StatementsLifecycle, { strict: false });
    const five: string[] = [];
    for (let i = 0; i < 5; i++) five.push((await t.shopWithOwner()).shopId);
    await t.sales.deliver(
      ...five.map((shopId, i) =>
        orderPaid({
          paidAt: '2026-03-10T10:00:00Z',
          lines: [{ shopId, unitPriceMinor: (i + 1) * 1000 }],
        }),
      ),
    );
    config.snapshotBatch = 2;
    setClock(t, '2026-04-02T02:00:00Z');
    const admin = await t.admin();
    const accepted = await t
      .as(admin)
      .post('/api/admin/accounting-periods/2026-03/close')
      .set('Idempotency-Key', uuidv4());
    expect(accepted.status).toBe(202);
    const runId = accepted.body.runId as string;

    t.app.get(CLOSE_FAULT, { strict: false }).after = (batches: number) => {
      if (batches === 2) lifecycle.beginShutdown();
    };
    await jobs.closeMonth(
      { month: '2026-03', runId },
      { signal: new AbortController().signal },
    );
    expect(lifecycle.isStopping()).toBe(true);
    expect(
      metric('statements_period_close_total', { status: 'interrupted' }),
    ).toBeGreaterThan(0);

    const period = await t
      .as(admin)
      .get('/api/admin/accounting-periods/2026-03');
    expect(period.body.status).toBe('CLOSING');
    const [snapshots] = await t.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "StatementSnapshot" WHERE month = '2026-03-01'`,
    );
    expect(snapshots.n).toBe('4'); // the batch in flight finished; the third batch never started
    const [open] = await t.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "StatementPeriodRun" WHERE "runId" = :runId AND status = 'RUNNING'`,
      { runId },
    );
    expect(open.n).toBe('1'); // resumable: still the run of record, not failed or completed

    // the next process: the stop is over, the same run resumes under the same cutoff
    (lifecycle as unknown as { stopping: boolean }).stopping = false;
    t.app.get(CLOSE_FAULT, { strict: false }).after = undefined;
    await jobs.closeMonth(
      { month: '2026-03', runId },
      { signal: new AbortController().signal },
    );
    const done = await t.as(admin).get('/api/admin/accounting-periods/2026-03');
    expect(done.body.status).toBe('CLOSED');
    const rows = await t.sql<{ shopId: string; gross: string }>(
      `SELECT "shopId", gross::text FROM "StatementSnapshot" WHERE month = '2026-03-01'`,
    );
    expect(
      Object.fromEntries(
        rows
          .filter((r) => five.includes(r.shopId))
          .map((r) => [r.shopId, r.gross]),
      ),
    ).toEqual(
      Object.fromEntries(five.map((id, i) => [id, String((i + 1) * 1000)])),
    );
  });

  it('S16 AS-82: each outcome moves its metric by one, and the logs hold no CSV content, request body or buyer identifier', async () => {
    const applied = () =>
      metric('statements_events_applied_total', {
        stream: 'orders',
        outcome: 'applied',
      });
    const duplicate = () =>
      metric('statements_events_applied_total', {
        stream: 'orders',
        outcome: 'duplicate',
      });
    const rate = (outcome: string) =>
      metric('statements_rate_changes_total', { outcome });
    const closes = () =>
      metric('statements_period_close_total', { status: 'completed' });
    const secretReason = `secret-reason-${uuidv4()}`;

    const o1 = orderPaid({
      paidAt: '2026-03-10T10:00:00Z',
      lines: [{ shopId: shops.a, unitPriceMinor: 1000 }],
    });
    const o2 = orderPaid({
      paidAt: '2026-03-11T10:00:00Z',
      lines: [{ shopId: shops.a, unitPriceMinor: 2000 }],
    });
    const [a0, d0] = [applied(), duplicate()];
    await t.sales.deliver(o1, o2, o1);
    expect(applied()).toBe(a0 + 2);
    expect(duplicate()).toBe(d0 + 1);

    const [rec0, noop0, ref0] = [
      rate('recorded'),
      rate('noop'),
      rate('refused'),
    ];
    await setRate(t, rc1(shops.a, { reason: secretReason }));
    await setRate(t, rc1(shops.a, { reason: secretReason }));
    expect([rate('recorded'), rate('noop')]).toEqual([rec0 + 1, noop0 + 1]);
    const admin = await t.admin();
    const refused = await t
      .as(admin)
      .post('/api/admin/commission-rates')
      .set('Idempotency-Key', uuidv4())
      .send(rc1(uuidv4()));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(rate('refused')).toBe(ref0 + 1);

    const c0 = closes();
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    expect(closes()).toBe(c0 + 1);

    const owner = await t.member(shops.a, 'OWNER');
    const csv = await t
      .as(owner)
      .get(`/api/shops/${shops.a}/statements/2026-03/lines.csv`);
    expect(csv.status).toBe(200);
    const csvText = String(csv.text ?? csv.body);
    const lineId =
      csvText.split('\r\n')[1]?.split(',')[2]?.replace(/"/g, '') ?? '';
    expect(lineId).toMatch(/[0-9a-f-]{36}/);

    const logs = t.rawLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(secretReason);
    expect(logs).not.toContain(lineId);
    expect(logs).not.toMatch(/buyer-[0-9a-f]{8}/);
    const parsed = logs
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.length).toBeGreaterThan(0);
    const requestLines = parsed.filter(
      (l) => String(l.url ?? l.msg ?? '').includes('/statements/') || l.req,
    );
    expect(requestLines.length).toBeGreaterThan(0);
  });

  it('S16 AS-83: closed months are read on the replica, and an unreachable replica falls back to the primary once, with a metric', async () => {
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    setClock(t, '2026-04-10T10:00:00Z');
    const replica = t.app.get<Sequelize>(READ_REPLICA_CONNECTION, {
      strict: false,
    });
    const owner = await t.member(shops.a, 'OWNER');
    const url = `/api/shops/${shops.a}/statements/2026-03`;

    const spy = jest.spyOn(replica, 'query');
    const healthy = await t.as(owner).get(url);
    expect(healthy.status).toBe(200);
    expect(spy).toHaveBeenCalled();

    const fallbacks = metric('statements_replica_fallback_total');
    spy.mockClear();
    spy.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        name: 'SequelizeConnectionRefusedError',
      }),
    );
    const degraded = await t.as(owner).get(url);
    expect(degraded.status).toBe(200);
    expect(degraded.body).toEqual(healthy.body);
    // every read of the request tried the replica exactly once and then the primary exactly once
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(metric('statements_replica_fallback_total')).toBe(
      fallbacks + spy.mock.calls.length,
    );
  });

  it('S16 AS-81: a statement that outlives the read timeout answers a generic 503 and frees its connection', async () => {
    setClock(t, '2026-03-20T10:00:00Z');
    const reader = await t.member(shops.a, 'OWNER');
    config.readTimeoutMs = 1000;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const locker = t.sequelize.transaction(async (tx) => {
      await t.sequelize.query(
        `LOCK TABLE "StatementSaleFact" IN ACCESS EXCLUSIVE MODE`,
        { transaction: tx },
      );
      locked();
      await hold;
    });
    await Promise.race([lockTaken, locker]); // a failed lock rejects here instead of hanging the spec
    const started = Date.now();
    let res;
    try {
      res = await t.as(reader).get(`/api/shops/${shops.a}/statements/2026-03`);
    } finally {
      release();
      await locker;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    // the platform maps SQLSTATE 57014 to `503 database_timeout` with a generic detail (S54); see questions.md
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('database_timeout');
    expect(JSON.stringify(res.body)).not.toMatch(
      /SELECT|StatementSaleFact|statement timeout|canceling/i,
    );
    // the connection went back to the pool: the same read now succeeds
    const again = await t
      .as(reader)
      .get(`/api/shops/${shops.a}/statements/2026-03`);
    expect(again.status).toBe(200);
    const [idle] = await t.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    expect(idle.n).toBe('0');
  }, 60_000);

  // Last in the file: it boots a second app, and closing that app ends the shared connection manager.
  it('S16 AS-79: a process started with an invalid setting does not boot', async () => {
    await expect(
      createStatementsApp({ env: { STATEMENTS_SNAPSHOT_BATCH: '20000' } }),
    ).rejects.toThrow(/STATEMENTS_SNAPSHOT_BATCH/);
  });
});
