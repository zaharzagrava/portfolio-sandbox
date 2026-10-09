import { INestApplication, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { JobsWorkerModule } from './jobs-worker.module';
import { JobsService } from './jobs.service';
import { JobWorker } from './job-worker.service';
import { JobMaintenance } from './job-maintenance.service';
import { JobHandler } from './job-handler.decorator';
import { NonRetryableJobError } from './job-types';
import type { JobContext } from './job-types';
import { nextFireAt } from './cron';

declare module './job-types' {
  interface JobPayloads {
    'spec.count': { n: number };
    'spec.flaky': { failTimes: number; key: string };
    'spec.poison': Record<string, never>;
  }
}

@Injectable()
class SpecHandlers {
  readonly executed: number[] = [];
  readonly flakyCalls = new Map<string, number>();

  @JobHandler('spec.count', { concurrency: 100 })
  async count({ n }: { n: number }) {
    this.executed.push(n);
  }

  @JobHandler('spec.flaky')
  async flaky(
    { failTimes, key }: { failTimes: number; key: string },
    ctx: JobContext,
  ) {
    const calls = (this.flakyCalls.get(key) ?? 0) + 1;
    this.flakyCalls.set(key, calls);
    if (ctx.attempt <= failTimes) throw new Error(`transient #${ctx.attempt}`);
  }

  @JobHandler('spec.poison')
  async poison() {
    throw new NonRetryableJobError('payload references a deleted entity');
  }
}

@Injectable()
class JobsSql {
  constructor(@InjectConnection() readonly sequelize: Sequelize) {}

  async statuses(type: string) {
    return this.sequelize.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM "Job" WHERE type = :type`,
      {
        type: QueryTypes.SELECT,
        replacements: { type },
      },
    );
  }

  async makeAllDue() {
    await this.sequelize.query(
      `UPDATE "Job" SET "runAt" = now() - interval '1 second' WHERE status = 'QUEUED'`,
    );
  }
}

/** SD-29 against the real test Postgres: exactly-once claiming under parallel workers, retries, DLQ-like DEAD, cron, idempotency. */
describe('Jobs (e2e, real Postgres)', () => {
  let app: INestApplication;
  let jobs: JobsService;
  let worker: JobWorker;
  let maintenance: JobMaintenance;
  let handlers: SpecHandlers;
  let sql: JobsSql;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([
      JobsWorkerModule,
      { module: class SpecModule {}, providers: [SpecHandlers, JobsSql] },
    ]);
    app = moduleRef.createNestApplication();
    await app.init();

    jobs = app.get(JobsService);
    worker = app.get(JobWorker);
    maintenance = app.get(JobMaintenance);
    handlers = app.get(SpecHandlers);
    sql = app.get(JobsSql);

    // Drive the loops by hand for determinism.
    await worker.stop();
    await maintenance.stop();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await sql.sequelize.query(`TRUNCATE "Job", "JobKey", "JobSchedule"`);
    handlers.executed.length = 0;
    handlers.flakyCalls.clear();
  });

  it('4 workers draining 400 due jobs in parallel execute each exactly once', async () => {
    for (let n = 0; n < 400; n++) await jobs.enqueue('spec.count', { n });

    // Several claim rounds from 4 concurrent "instances" (same process, separate claims).
    for (let round = 0; round < 6; round++)
      await inParallel(4, () => worker.runOnce(50));

    expect(handlers.executed).toHaveLength(400);
    expect(new Set(handlers.executed).size).toBe(400);
    expect(
      (await sql.statuses('spec.count')).every((j) => j.status === 'SUCCEEDED'),
    ).toBe(true);
  });

  it('retries transient failures with backoff and succeeds on a later attempt', async () => {
    await jobs.enqueue('spec.flaky', { failTimes: 2, key: 'a' });

    for (let i = 0; i < 3; i++) {
      await worker.runOnce();
      await sql.makeAllDue(); // skip the backoff delay
    }

    expect(await sql.statuses('spec.flaky')).toEqual([
      { status: 'SUCCEEDED', attempts: 3 },
    ]);
  });

  it('non-retryable errors go straight to DEAD; retryable ones go DEAD after maxAttempts', async () => {
    await jobs.enqueue('spec.poison', {});
    await jobs.enqueue(
      'spec.flaky',
      { failTimes: 99, key: 'b' },
      { maxAttempts: 2 },
    );

    for (let i = 0; i < 3; i++) {
      await worker.runOnce();
      await sql.makeAllDue();
    }

    expect(await sql.statuses('spec.poison')).toEqual([
      { status: 'DEAD', attempts: 1 },
    ]);
    expect(await sql.statuses('spec.flaky')).toEqual([
      { status: 'DEAD', attempts: 2 },
    ]);
  });

  it('idempotency key: concurrent enqueues of the same key create one job', async () => {
    const key = `order-${v4()}`;
    const results = await inParallel(10, () =>
      jobs.enqueue('spec.count', { n: 1 }, { idempotencyKey: key }),
    );

    const ids = results.map((r) =>
      r.status === 'fulfilled' ? r.value.id : 'rejected',
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.created),
    ).toHaveLength(1);
    expect(await sql.statuses('spec.count')).toHaveLength(1);
  });

  it('a job whose worker died (expired lease) is reaped and executed again', async () => {
    await jobs.enqueue('spec.count', { n: 42 });
    await sql.sequelize.query(
      `UPDATE "Job" SET status = 'RUNNING', "lockedBy" = 'dead-worker', "lockedUntil" = now() - interval '1 second', attempts = 1`,
    );

    expect(await maintenance.reapExpiredLeases()).toBe(1);
    await worker.runOnce();

    expect(handlers.executed).toEqual([42]);
  });

  it('cron materializer creates one job per fire even when two instances tick at once', async () => {
    await jobs.upsertSchedule({
      name: 'spec.every-minute',
      cron: '* * * * *',
      jobType: 'spec.count',
      payload: { n: 7 },
    });
    await sql.sequelize.query(
      `UPDATE "JobSchedule" SET "nextFireAt" = now() - interval '1 second'`,
    );

    await inParallel(3, () => maintenance.materializeDueSchedules());

    expect(await sql.statuses('spec.count')).toHaveLength(1);
  });

  it('next fire keeps local wall-clock time across DST (Europe/Warsaw)', () => {
    // 2026-03-29 is the spring-forward day in the EU.
    const before = nextFireAt(
      '0 9 * * *',
      'Europe/Warsaw',
      new Date('2026-03-28T10:00:00Z'),
    );
    const after = nextFireAt(
      '0 9 * * *',
      'Europe/Warsaw',
      new Date('2026-03-29T10:00:00Z'),
    );
    expect(before.toISOString()).toBe('2026-03-29T07:00:00.000Z'); // 09:00 CEST (UTC+2)
    expect(after.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    expect(
      nextFireAt(
        '0 9 * * *',
        'Europe/Warsaw',
        new Date('2026-03-27T10:00:00Z'),
      ).toISOString(),
    ).toBe('2026-03-28T08:00:00.000Z'); // CET (UTC+1)
  });
});
