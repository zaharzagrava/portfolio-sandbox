import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { declareJobType } from './job-type-registry';
import { InvalidScheduleError } from './job-errors';
import { JobsAdminService } from './jobs-admin.service';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'cron.work': { n: number };
    'cron.retried': { n: number };
  }
}
declareJobType({ name: 'cron.work', contract: z.object({ n: z.number() }) });
declareJobType({
  name: 'cron.retried',
  contract: z.object({ n: z.number() }),
  maxAttempts: 4,
});

describe('Recurring schedules (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let admin: JobsAdminService;

  const sql = <R extends object = Record<string, any>>(
    text: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(text, { type: QueryTypes.SELECT, replacements });
  const jobs = (where = '1=1') =>
    sql(`SELECT * FROM "Job" WHERE ${where} ORDER BY "runAt", id`);
  const schedule = async (name: string) =>
    (await sql(`SELECT * FROM "JobSchedule" WHERE name = :name`, { name }))[0];
  const HOURLY = {
    cron: '0 * * * *',
    jobType: 'cron.work' as const,
    payload: { n: 1 },
  };
  const toNextFire = async (name: string) => {
    const s = await schedule(name);
    t.clock.set(new Date(s.nextFireAt));
  };

  beforeAll(async () => {
    t = await createJobsTestApp();
    admin = t.get(JobsAdminService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('S49 AS-53: a due schedule becomes one job with the key cron:<name>:<fireAt>', async () => {
    await t.jobs.upsertSchedule({ name: 'hourly', ...HOURLY });
    expect(new Date((await schedule('hourly')).nextFireAt).toISOString()).toBe(
      '2026-10-09T11:00:00.000Z',
    );
    expect(await t.maintenance.materializeDueSchedules()).toBe(0); // nothing due yet

    await toNextFire('hourly');
    expect(await t.maintenance.materializeDueSchedules()).toBe(1);

    const [job] = await jobs();
    expect(job).toMatchObject({
      type: 'cron.work',
      status: 'QUEUED',
      idempotencyKey: 'cron:hourly:2026-10-09T11:00:00.000Z',
      scheduleName: 'hourly',
    });
    expect(new Date(job.runAt).toISOString()).toBe('2026-10-09T11:00:00.000Z');
    expect(
      (
        await sql(`SELECT "jobId" FROM "JobKey" WHERE "idempotencyKey" = :k`, {
          k: job.idempotencyKey,
        })
      )[0].jobId,
    ).toBe(job.id);
    const s = await schedule('hourly');
    expect(new Date(s.nextFireAt).toISOString()).toBe(
      '2026-10-09T12:00:00.000Z',
    );
    expect(new Date(s.lastFiredAt).toISOString()).toBe(
      '2026-10-09T11:00:00.000Z',
    );
  });

  it('S49 AS-54: five instances ticking at once elect one leader and create one job', async () => {
    await t.jobs.upsertSchedule({ name: 'hourly', ...HOURLY });
    await toNextFire('hourly');
    const instances = [
      t.maintenance,
      ...Array.from({ length: 4 }, () => t.newMaintenance()),
    ];

    const processed = await Promise.all(
      instances.map((m) => m.materializeDueSchedules()),
    );

    expect(processed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(processed.filter((n) => n === 0)).toHaveLength(4);
    expect(await jobs()).toHaveLength(1);
  });

  it('S49 AS-55: a leader that dies mid-tick leaves no partial effect and the next instance fires once', async () => {
    await t.jobs.upsertSchedule({ name: 'hourly', ...HOURLY });
    await t.jobs.upsertSchedule({ name: 'hourly-two', ...HOURLY });
    await toNextFire('hourly');
    const runner = t.get<TransactionRunner>(TransactionRunner);
    const real = runner.run.bind(runner);
    const spy = jest.spyOn(runner, 'run').mockImplementationOnce(((
      fn: any,
      options: any,
    ) =>
      real(async (tx: any) => {
        await fn(tx);
        throw new Error('leader process killed before commit');
      }, options)) as never);

    await expect(t.maintenance.materializeDueSchedules()).rejects.toThrow(
      'leader process killed',
    );
    spy.mockRestore();

    expect(await jobs()).toHaveLength(0);
    expect(await sql(`SELECT * FROM "JobKey"`)).toHaveLength(0);
    expect(new Date((await schedule('hourly')).nextFireAt).toISOString()).toBe(
      '2026-10-09T11:00:00.000Z',
    );

    expect(await t.newMaintenance().materializeDueSchedules()).toBe(2);
    expect(await jobs()).toHaveLength(2);
  });

  it('S49 AS-56: a duplicate materialisation of the same fire is deduplicated by its key', async () => {
    await t.jobs.upsertSchedule({ name: 'hourly', ...HOURLY });
    await toNextFire('hourly');
    await t.maintenance.materializeDueSchedules();
    // the schedule row is rewound, as after a restore or a second leader with a stale view
    await sql(
      `UPDATE "JobSchedule" SET "nextFireAt" = '2026-10-09T11:00:00Z' WHERE name = 'hourly'`,
    );

    await t.maintenance.materializeDueSchedules();

    expect(await jobs()).toHaveLength(1);
    expect(new Date((await schedule('hourly')).nextFireAt).toISOString()).toBe(
      '2026-10-09T12:00:00.000Z',
    );
  });

  it('S49 AS-57: an outage over three daily fires collapses into one catch-up job', async () => {
    await t.jobs.upsertSchedule({
      name: 'daily',
      cron: '0 9 * * *',
      jobType: 'cron.work',
      payload: { n: 1 },
    });
    t.clock.set(new Date('2026-10-12T12:00:00Z')); // three fires (10th, 11th, 12th at 09:00) missed

    await t.maintenance.materializeDueSchedules();

    const created = await jobs();
    expect(created).toHaveLength(1);
    expect(created[0].idempotencyKey).toBe(
      'cron:daily:2026-10-10T09:00:00.000Z',
    );
    expect(new Date((await schedule('daily')).nextFireAt).toISOString()).toBe(
      '2026-10-13T09:00:00.000Z',
    );
  });

  it('S49 AS-58: overlap skip skips a fire while the previous job is active; allow always creates', async () => {
    await t.jobs.upsertSchedule({
      name: 'skipper',
      ...HOURLY,
      overlap: 'skip',
    });
    await t.jobs.upsertSchedule({
      name: 'allower',
      ...HOURLY,
      overlap: 'allow',
    });
    const skippedBefore =
      MetricsRegistry.value('cron_fires_skipped_total', {
        schedule: 'skipper',
      }) ?? 0;

    await toNextFire('skipper');
    await t.maintenance.materializeDueSchedules();
    t.clock.advance(3_600_000);
    await t.maintenance.materializeDueSchedules(); // the first jobs are still QUEUED

    expect(await jobs(`"scheduleName" = 'skipper'`)).toHaveLength(1);
    expect(await jobs(`"scheduleName" = 'allower'`)).toHaveLength(2);
    expect(
      MetricsRegistry.value('cron_fires_skipped_total', {
        schedule: 'skipper',
      }),
    ).toBe(skippedBefore + 1);
    expect(new Date((await schedule('skipper')).nextFireAt).toISOString()).toBe(
      '2026-10-09T13:00:00.000Z',
    );

    await sql(
      `UPDATE "Job" SET status = 'SUCCEEDED', "finishedAt" = :now WHERE "scheduleName" = 'skipper'`,
      {
        now: t.clock.now(),
      },
    );
    t.clock.advance(3_600_000);
    await t.maintenance.materializeDueSchedules();
    expect(await jobs(`"scheduleName" = 'skipper'`)).toHaveLength(2);
  });

  it('S49 AS-59: upserting the same definition again changes nothing; only a cron or zone change recomputes the next fire', async () => {
    await t.jobs.upsertSchedule({ name: 'stable', ...HOURLY });
    const first = await schedule('stable');
    t.clock.advance(1_000_000);

    await t.jobs.upsertSchedule({ name: 'stable', ...HOURLY });
    expect(await schedule('stable')).toEqual(first);

    await t.jobs.upsertSchedule({
      name: 'stable',
      ...HOURLY,
      payload: { n: 2 },
    });
    const afterPayload = await schedule('stable');
    expect(afterPayload.payload).toEqual({ n: 2 });
    expect(afterPayload.nextFireAt).toEqual(first.nextFireAt);

    await t.jobs.upsertSchedule({
      name: 'stable',
      ...HOURLY,
      payload: { n: 2 },
      cron: '30 * * * *',
    });
    expect(new Date((await schedule('stable')).nextFireAt).toISOString()).toBe(
      '2026-10-09T10:30:00.000Z',
    );

    await t.jobs.upsertSchedule({
      name: 'stable',
      ...HOURLY,
      payload: { n: 2 },
      cron: '30 * * * *',
      timezone: 'Asia/Kolkata',
    });
    // minute 30 in Kolkata (UTC+5:30) is minute 00 UTC: 16:30 IST
    expect(new Date((await schedule('stable')).nextFireAt).toISOString()).toBe(
      '2026-10-09T11:00:00.000Z',
    );
    await t.jobs.upsertSchedule({
      name: 'stable',
      ...HOURLY,
      payload: { n: 2 },
      cron: '0 9 * * *',
      timezone: 'Asia/Kolkata',
    });
    expect(new Date((await schedule('stable')).nextFireAt).toISOString()).toBe(
      '2026-10-10T03:30:00.000Z',
    );
  });

  it('S49 AS-60: eight replicas upserting the same schedule at boot leave one consistent row', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        t.jobs.upsertSchedule({ name: 'boot', ...HOURLY }),
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      await sql(`SELECT * FROM "JobSchedule" WHERE name = 'boot'`),
    ).toHaveLength(1);
  });

  it('S49 AS-61: an invalid schedule is rejected and the stored one stays as it was', async () => {
    await t.jobs.upsertSchedule({ name: 'valid', ...HOURLY });
    const before = await schedule('valid');
    const bad: Array<[string, Record<string, unknown>, string]> = [
      ['cron', { cron: 'not a cron' }, 'cron'],
      ['timezone', { timezone: 'Mars/Base' }, 'timezone'],
      ['type', { jobType: 'cron.undeclared' }, 'jobType'],
      ['payload', { payload: { n: 'x' } }, 'payload'],
      ['maxAttempts', { maxAttempts: 99 }, 'maxAttempts'],
    ];

    for (const [, patch, field] of bad)
      await expect(
        t.jobs.upsertSchedule({ name: 'valid', ...HOURLY, ...patch } as never),
      ).rejects.toEqual(
        expect.objectContaining({ name: InvalidScheduleError.name, field }),
      );
    await expect(
      t.jobs.upsertSchedule({ name: 'Bad Name', ...HOURLY }),
    ).rejects.toEqual(expect.objectContaining({ field: 'name' }));

    expect(await schedule('valid')).toEqual(before);
    expect(await sql(`SELECT * FROM "JobSchedule"`)).toHaveLength(1);
  });

  it('S49 AS-62: a disabled schedule does not fire and enabling it again does not catch up', async () => {
    await t.jobs.upsertSchedule({ name: 'toggle', ...HOURLY });
    expect(await admin.setScheduleEnabled('toggle', false)).toBe(true);
    t.clock.advance(3 * 86_400_000);

    await t.maintenance.materializeDueSchedules();
    expect(await jobs()).toHaveLength(0);

    expect(await admin.setScheduleEnabled('toggle', true)).toBe(true);
    expect(new Date((await schedule('toggle')).nextFireAt).toISOString()).toBe(
      '2026-10-12T11:00:00.000Z',
    );
    await t.maintenance.materializeDueSchedules();
    expect(await jobs()).toHaveLength(0);
    expect(await admin.setScheduleEnabled('nobody', true)).toBe(false);
  });

  it('S49 AS-63: removing a schedule keeps the jobs it already created', async () => {
    await t.jobs.upsertSchedule({ name: 'gone', ...HOURLY });
    await toNextFire('gone');
    await t.maintenance.materializeDueSchedules();

    expect(await t.jobs.removeSchedule('gone')).toBe(true);
    expect(await t.jobs.removeSchedule('gone')).toBe(false);

    expect(await jobs()).toHaveLength(1);
    expect(await sql(`SELECT * FROM "JobSchedule"`)).toHaveLength(0);
  });

  it('S49 AS-64: 1,200 due schedules are materialised over three ticks of at most 500', async () => {
    await sql(
      `INSERT INTO "JobSchedule" (name, cron, timezone, "jobType", payload, "nextFireAt")
       SELECT 'bulk-' || i, '0 * * * *', 'UTC', 'cron.work', '{"n":1}', :due::timestamptz + i * interval '1 second'
       FROM generate_series(1, 1200) i`,
      { due: new Date(t.clock.now().getTime() - 3_600_000) },
    );

    const counts = [
      await t.maintenance.materializeDueSchedules(),
      await t.maintenance.materializeDueSchedules(),
      await t.maintenance.materializeDueSchedules(),
    ];

    expect(counts).toEqual([500, 500, 200]);
    expect(await jobs()).toHaveLength(1_200);
    expect(await t.maintenance.materializeDueSchedules()).toBe(0);
  }, 120_000);

  it('S49 AS-65: a failing schedule is isolated, then disabled after five failing ticks', async () => {
    await t.jobs.upsertSchedule({ name: 'healthy', ...HOURLY });
    await sql(
      `INSERT INTO "JobSchedule" (name, cron, timezone, "jobType", payload, "nextFireAt")
       VALUES ('broken', '0 * * * *', 'UTC', 'cron.undeclared', '{}', :due)`,
      { due: new Date(t.clock.now().getTime() - 60_000) },
    );
    await sql(
      `UPDATE "JobSchedule" SET "nextFireAt" = :due WHERE name = 'healthy'`,
      {
        due: new Date(t.clock.now().getTime() - 60_000),
      },
    );

    await t.maintenance.materializeDueSchedules();
    expect(await jobs(`"scheduleName" = 'healthy'`)).toHaveLength(1);
    expect(await schedule('broken')).toMatchObject({
      consecutiveFailures: 1,
      enabled: true,
    });

    for (let i = 0; i < 3; i++) await t.maintenance.materializeDueSchedules();
    expect(await schedule('broken')).toMatchObject({
      consecutiveFailures: 4,
      enabled: true,
    });
    await t.maintenance.materializeDueSchedules();

    const broken = await schedule('broken');
    expect(broken).toMatchObject({ consecutiveFailures: 5, enabled: false });
    expect(broken.lastError).toContain('cron.undeclared');
    expect(await t.maintenance.materializeDueSchedules()).toBe(0);
    expect(await jobs(`"scheduleName" = 'broken'`)).toHaveLength(0);
  });

  it('S49 AS-66: the schedule maxAttempts is used by the jobs it creates, then the type default', async () => {
    await t.jobs.upsertSchedule({
      name: 'explicit',
      ...HOURLY,
      maxAttempts: 3,
    });
    await t.jobs.upsertSchedule({
      name: 'typed',
      cron: '0 * * * *',
      jobType: 'cron.retried',
      payload: { n: 1 },
    });
    await t.jobs.upsertSchedule({ name: 'plain', ...HOURLY });
    t.clock.advance(3_600_000);

    await t.maintenance.materializeDueSchedules();

    const max = async (name: string) =>
      (await jobs(`"scheduleName" = '${name}'`))[0].maxAttempts;
    expect(await max('explicit')).toBe(3);
    expect(await max('typed')).toBe(4);
    expect(await max('plain')).toBe(8);
  });

  it('S49 AS-67: a six-field schedule with a seconds field fires every 10 seconds', async () => {
    await t.jobs.upsertSchedule({
      name: 'seconds',
      cron: '*/10 * * * * *',
      jobType: 'cron.work',
      payload: { n: 1 },
    });

    for (let i = 0; i < 3; i++) {
      t.clock.advance(10_000);
      await t.maintenance.materializeDueSchedules();
      await sql(`UPDATE "Job" SET status = 'SUCCEEDED', "finishedAt" = :now`, {
        now: t.clock.now(),
      });
    }

    expect((await jobs()).map((j) => new Date(j.runAt).toISOString())).toEqual([
      '2026-10-09T10:00:10.000Z',
      '2026-10-09T10:00:20.000Z',
      '2026-10-09T10:00:30.000Z',
    ]);
  });
});
