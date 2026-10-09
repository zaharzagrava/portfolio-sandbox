import { Injectable, Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sleep } from '@app/common/core/backoff';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { CANDIDATE_SQL } from './job-claim.sql';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'ret.work': { n: number };
  }
}
declareJobType({ name: 'ret.work', contract: z.object({ n: z.number() }) });

@Injectable()
class RetHandlers {
  @JobHandler('ret.work', { concurrency: 500 })
  async work() {}
}

/** Sizes of the heavy rows; the full run (200,000 rows, 5,000 cycles) is an ops artifact, see quickstart.md. */
const PLAN_ROWS = Number(process.env.S49_PLAN_ROWS ?? 20_000);
const HOT_CYCLES = Number(process.env.S49_HOT_CYCLES ?? 500);

describe('Job retention, partitions and storage health (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;

  const sql = <R extends object = Record<string, any>>(
    text: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(text, { type: QueryTypes.SELECT, replacements });
  const D = new Date('2026-10-09T10:00:00.000Z');
  const dayOf = (offset: number, from = D) =>
    new Date(from.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const partName = (day: string) => `Job_${day.replaceAll('-', '')}`;
  const partitions = async () =>
    (
      await sql<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = '"Job"'::regclass ORDER BY 1`,
      )
    ).map((r) => r.relname);
  const exists = async (name: string) =>
    (
      await sql<{ r: string | null }>(`SELECT to_regclass(:q) AS r`, {
        q: `"${name}"`,
      })
    )[0].r !== null;
  const dropAllDayPartitions = async () => {
    for (const name of await partitions())
      if (name !== 'Job_default') await sql(`DROP TABLE "${name}"`);
  };
  const maintain = (
    payload: { aheadDays?: number; retainDays?: number } = {},
  ) => t.maintenance.maintainPartitions(payload);

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [RetHandlers] });
  });
  afterAll(async () => {
    await dropAllDayPartitions();
    await sql(
      `SELECT job_ensure_partitions((now() - interval '1 day')::date, 16)`,
    );
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await dropAllDayPartitions();
    await sql(`SELECT job_ensure_partitions(:from::date, 16)`, {
      from: dayOf(-1),
    });
  });

  const insertAt = (createdAt: string, status: string, finishedAt?: string) =>
    sql(
      `INSERT INTO "Job" (type, payload, status, "runAt", "createdAt", "finishedAt")
       VALUES ('ret.work', '{"n":1}', :status, :createdAt, :createdAt, :finishedAt)`,
      { status, createdAt, finishedAt: finishedAt ?? null },
    );

  it('S49 AS-09: a key is kept while its job finished less than 30 days ago and freed after that', async () => {
    const first = await t.jobs.enqueue(
      'ret.work',
      { n: 1 },
      { idempotencyKey: 'K' },
    );
    const age = (days: number) => new Date(D.getTime() - days * 86_400_000);
    // the job finished 29 days ago; the key itself is older than the retention
    await sql(
      `UPDATE "Job" SET status = 'SUCCEEDED', "finishedAt" = :f WHERE id = :id`,
      { f: age(29), id: first.id },
    );
    await sql(`UPDATE "JobKey" SET "createdAt" = :c`, { c: age(35) });
    await maintain({});
    expect(
      await t.jobs.enqueue('ret.work', { n: 1 }, { idempotencyKey: 'K' }),
    ).toEqual({ id: first.id, created: false });

    // finished 31 days ago and its partition is gone with it
    await sql(`UPDATE "Job" SET "finishedAt" = :f WHERE id = :id`, {
      f: age(31),
      id: first.id,
    });
    await sql(`DELETE FROM "Job" WHERE id = :id`, { id: first.id });
    await maintain({});

    const again = await t.jobs.enqueue(
      'ret.work',
      { n: 1 },
      { idempotencyKey: 'K' },
    );
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(first.id);
  });

  it('S49 AS-84: partitions are created ahead, a second run adds nothing, and the next day adds exactly one', async () => {
    const before = await partitions();
    expect(before).toContain(partName(dayOf(-1)));
    expect(before).toContain(partName(dayOf(14)));

    await maintain({ aheadDays: 14 });
    await maintain({ aheadDays: 14 });
    expect(await partitions()).toEqual(before);

    t.clock.advance(86_400_000);
    await maintain({ aheadDays: 14 });
    const after = await partitions();
    expect(after.filter((p) => !before.includes(p))).toEqual([
      partName(dayOf(15)),
    ]);
  });

  it('S49 AS-85: only a finished, old partition is dropped; queued, recently dead and young ones stay', async () => {
    const old = [dayOf(-40), dayOf(-41), dayOf(-42)];
    const young = dayOf(-10);
    await sql(`SELECT job_ensure_partitions(:d::date, 1)`, { d: old[0] });
    await sql(`SELECT job_ensure_partitions(:d::date, 1)`, { d: old[1] });
    await sql(`SELECT job_ensure_partitions(:d::date, 1)`, { d: old[2] });
    await sql(`SELECT job_ensure_partitions(:d::date, 1)`, { d: young });
    const at = (day: string) => `${day}T08:00:00Z`;
    await insertAt(at(old[0]), 'SUCCEEDED', at(old[0]));
    await insertAt(at(old[1]), 'QUEUED');
    await insertAt(at(old[2]), 'DEAD', at(dayOf(-5)));
    await insertAt(at(young), 'SUCCEEDED', at(young));

    await maintain({ retainDays: 30 });

    expect(await exists(partName(old[0]))).toBe(false);
    expect(await exists(partName(old[1]))).toBe(true);
    expect(await exists(partName(old[2]))).toBe(true);
    expect(await exists(partName(young))).toBe(true);
    expect(
      Number((await sql(`SELECT count(*)::int AS n FROM "Job"`))[0].n),
    ).toBe(3);
  });

  it('S49 AS-86: a job with no partition for its day is stored in the default partition and reported', async () => {
    const warnings: unknown[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...a: unknown[]) => {
        warnings.push(a[0]);
      });
    try {
      await insertAt('2030-01-01T00:00:00Z', 'QUEUED');
      const [row] = await sql<{ part: string }>(
        `SELECT tableoid::regclass::text AS part FROM "Job"`,
      );
      expect(row.part).toBe('"Job_default"');

      await maintain({});
    } finally {
      spy.mockRestore();
    }

    expect(MetricsRegistry.value('job_default_partition_rows')).toBe(1);
    expect(JSON.stringify(warnings)).toContain('default partition');
  });

  it('S49 AS-87: expired keys are purged in batches of at most 10,000 and newer keys stay', async () => {
    await sql(
      `INSERT INTO "JobKey" ("idempotencyKey", "jobId", "createdAt")
       SELECT 'old-' || i, uuidv7(), :old::timestamptz + i * interval '1 millisecond' FROM generate_series(1, 25000) i`,
      { old: new Date(D.getTime() - 40 * 86_400_000) },
    );
    await sql(
      `INSERT INTO "JobKey" ("idempotencyKey", "jobId", "createdAt")
       SELECT 'new-' || i, uuidv7(), :recent FROM generate_series(1, 5) i`,
      { recent: new Date(D.getTime() - 5 * 86_400_000) },
    );
    const batches: number[] = [];
    const real = t.sequelize.query.bind(t.sequelize) as (
      ...a: any[]
    ) => Promise<any>;
    const spy = jest.spyOn(t.sequelize, 'query').mockImplementation((async (
      ...a: any[]
    ) => {
      const result = await real(...a);
      if (typeof a[0] === 'string' && a[0].startsWith('DELETE FROM "JobKey"'))
        batches.push(result.length);
      return result;
    }) as never);
    try {
      expect(await t.maintenance.purgeKeys(30)).toBe(25_000);
    } finally {
      spy.mockRestore();
    }

    expect(batches).toEqual([10_000, 10_000, 5_000]);
    expect(
      Number((await sql(`SELECT count(*)::int AS n FROM "JobKey"`))[0].n),
    ).toBe(5);
  }, 60_000);

  it(`S49 AS-88: the claim reads through the partial due index and touches few rows among ${PLAN_ROWS} jobs`, async () => {
    await sql(
      `INSERT INTO "Job" (type, payload, status, "runAt", "finishedAt")
       SELECT 'ret.work', '{"n":1}', 'SUCCEEDED', :past, :past FROM generate_series(1, :finished)`,
      { past: new Date(D.getTime() - 86_400_000), finished: PLAN_ROWS - 100 },
    );
    await sql(
      `INSERT INTO "Job" (type, payload, status, "runAt")
       SELECT 'ret.work', '{"n":1}', 'QUEUED', :due::timestamptz + i * interval '1 second' FROM generate_series(1, 100) i`,
      { due: new Date(D.getTime() - 3_600_000) },
    );
    await sql(`ANALYZE "Job"`);
    const runner = t.get<TransactionRunner>(TransactionRunner);

    const plan = await runner
      .run(
        async (tx) => {
          const [{ 'QUERY PLAN': json }] = await t.sequelize.query<{
            'QUERY PLAN': any;
          }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${CANDIDATE_SQL}`, {
            type: QueryTypes.SELECT,
            bind: [D, ['ret.work'], [], 200],
            transaction: tx,
          });
          throw Object.assign(new Error('rollback'), { plan: json });
        },
        { propagation: 'requires_new' },
      )
      .catch((e) => e.plan);

    const nodes: any[] = [];
    const walk = (n: any) => {
      nodes.push(n);
      (n.Plans ?? []).forEach(walk);
    };
    walk(plan[0].Plan);
    const scans = nodes.filter(
      (n) => /Scan/.test(n['Node Type']) && n['Relation Name'],
    );
    expect(scans.some((n) => /Index/.test(n['Node Type']))).toBe(true);
    expect(
      scans.filter(
        (n) => n['Node Type'] === 'Seq Scan' && n['Actual Rows'] > 0,
      ),
    ).toEqual([]);
    const touched = scans.reduce(
      (sum, n) =>
        sum + (n['Actual Rows'] ?? 0) + (n['Rows Removed by Filter'] ?? 0),
      0,
    );
    expect(touched).toBeLessThan(1_000);
  }, 120_000);

  it(`S49 AS-89: at least 90% of the updates of ${HOT_CYCLES} claim-and-complete cycles are heap-only`, async () => {
    const stat = async () =>
      (
        await sql<{ upd: string; hot: string }>(
          `SELECT coalesce(sum(n_tup_upd), 0)::text AS upd, coalesce(sum(n_tup_hot_upd), 0)::text AS hot
           FROM pg_stat_user_tables WHERE relname LIKE 'Job\\_%'`,
        )
      )[0];
    await sleep(1_500);
    const before = await stat();
    for (let i = 0; i < HOT_CYCLES; i += 50)
      await Promise.all(
        Array.from({ length: Math.min(50, HOT_CYCLES - i) }, (_, k) =>
          t.jobs.enqueue('ret.work', { n: i + k }),
        ),
      );
    while ((await t.worker.runOnce(50)) > 0);
    await sleep(12_000); // idle backends report their counters after 10 s
    const after = await stat();

    const updates = Number(after.upd) - Number(before.upd);
    const hot = Number(after.hot) - Number(before.hot);
    expect(updates).toBeGreaterThanOrEqual(HOT_CYCLES * 2);
    expect(hot / updates).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it('S49 AS-90: a partition is dropped by its catalog name; a lock it cannot get in time makes it skip without damage', async () => {
    const day = dayOf(-45);
    await sql(`SELECT job_ensure_partitions(:d::date, 1)`, { d: day });
    await insertAt(`${day}T08:00:00Z`, 'SUCCEEDED', `${day}T08:00:00Z`);
    const name = partName(day);

    // a reader holds the partition: the drop waits for its lock for 500 ms, gives up, and leaves everything in place
    const runner = t.get<TransactionRunner>(TransactionRunner);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = runner.run(
      async (tx) => {
        await t.sequelize.query(`LOCK TABLE "${name}" IN ACCESS SHARE MODE`, {
          transaction: tx,
        });
        locked();
        await held;
      },
      { propagation: 'requires_new' },
    );
    await lockTaken;
    const started = Date.now();
    const skipped = await sql<{ name: string }>(
      `SELECT job_drop_expired_partitions(30, 500, :now) AS name`,
      { now: D },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(skipped).toEqual([]);
    release();
    await holder;
    expect(await exists(name)).toBe(true);
    expect(
      Number((await sql(`SELECT count(*)::int AS n FROM "Job"`))[0].n),
    ).toBe(1);

    const dropped = await sql<{ name: string }>(
      `SELECT job_drop_expired_partitions(30, 500, :now) AS name`,
      { now: D },
    );
    expect(dropped.map((r) => r.name)).toEqual([name]);
    expect(await exists(name)).toBe(false);
  });

  it('S49 AS-90: a hostile partition name is quoted as an identifier, never run as SQL', async () => {
    const day = dayOf(-50);
    const next = dayOf(-49);
    const evil = `Job_evil"; DROP TABLE "JobKey"; --`;
    await sql(
      `CREATE TABLE "${evil.replaceAll('"', '""')}" PARTITION OF "Job" FOR VALUES FROM ('${day}') TO ('${next}')`,
    );

    const dropped = await sql<{ name: string }>(
      `SELECT job_drop_expired_partitions(30, 500, :now) AS name`,
      { now: D },
    );

    expect(dropped.map((r) => r.name)).toEqual([evil]);
    expect(await exists('JobKey')).toBe(true);
    expect(await exists(evil)).toBe(false);
  });
});
