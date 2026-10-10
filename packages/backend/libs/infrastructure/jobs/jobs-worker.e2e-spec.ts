import { Injectable, Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sleep } from '@app/common/core/backoff';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import { NonRetryableJobError } from './job-types';
import type { JobContext } from './job-types';
import { retryCeilingMs } from './backoff';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'run.count': { n: number };
    'run.flaky': { failTimes: number; key: string };
    'run.poison': Record<string, never>;
    'run.bulk': { n: number };
    'run.fleet': { n: number };
    'run.leased': { n: number };
    'run.nohandler': { n: number };
    'run.ctx': { key: string };
    'run.secret': { secret: string };
    'run.timeout': { n: number };
  }
}

const n = z.object({ n: z.number() });
declareJobType({ name: 'run.count', contract: n });
declareJobType({
  name: 'run.flaky',
  contract: z.object({ failTimes: z.number(), key: z.string() }),
});
declareJobType({ name: 'run.poison', contract: z.object({}) });
declareJobType({ name: 'run.bulk', contract: n });
declareJobType({ name: 'run.fleet', contract: n });
declareJobType({ name: 'run.leased', contract: n });
declareJobType({ name: 'run.nohandler', contract: n });
declareJobType({ name: 'run.ctx', contract: z.object({ key: z.string() }) });
declareJobType({
  name: 'run.secret',
  contract: z.object({ secret: z.string() }),
});
declareJobType({ name: 'run.timeout', contract: n });

class Gate {
  private release!: () => void;
  readonly opened = new Promise<void>((resolve) => (this.release = resolve));
  open() {
    this.release();
  }
}

@Injectable()
class RunHandlers {
  readonly executed: number[] = [];
  readonly started: number[] = [];
  readonly contexts: Array<
    Pick<JobContext, 'jobId' | 'attempt' | 'maxAttempts' | 'isLastAttempt'>
  > = [];
  readonly abortReasons: unknown[] = [];
  gate = new Gate();

  @JobHandler('run.count', { concurrency: 100 })
  async count({ n }: { n: number }) {
    this.executed.push(n);
  }

  @JobHandler('run.flaky')
  async flaky(
    { failTimes }: { failTimes: number; key: string },
    ctx: JobContext,
  ) {
    if (ctx.attempt <= failTimes) throw new Error(`transient #${ctx.attempt}`);
  }

  @JobHandler('run.poison')
  async poison() {
    throw new NonRetryableJobError('payload references a deleted entity');
  }

  @JobHandler('run.bulk', { concurrency: 3 })
  async bulk({ n }: { n: number }) {
    this.started.push(n);
    await this.gate.opened;
  }

  @JobHandler('run.fleet', { concurrency: 10, fleetConcurrency: 1 })
  async fleet({ n }: { n: number }) {
    this.started.push(n);
    await this.gate.opened;
  }

  @JobHandler('run.leased', { leaseMs: 90_000, maxRuntimeMs: 90_000 })
  async leased({ n }: { n: number }) {
    this.started.push(n);
    await this.gate.opened;
  }

  @JobHandler('run.ctx')
  async ctx(_payload: { key: string }, ctx: JobContext) {
    this.contexts.push({
      jobId: ctx.jobId,
      attempt: ctx.attempt,
      maxAttempts: ctx.maxAttempts,
      isLastAttempt: ctx.isLastAttempt,
    });
    throw new Error('keep failing');
  }

  @JobHandler('run.secret')
  async secret() {
    throw new Error('x'.repeat(3_000));
  }

  @JobHandler('run.timeout', { leaseMs: 5_000, maxRuntimeMs: 5_000 })
  async timeout({ n }: { n: number }, ctx: JobContext) {
    this.started.push(n);
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    this.abortReasons.push(ctx.signal.reason);
  }
}

describe('Job worker: claiming (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let h: RunHandlers;

  const rows = <R extends object = Record<string, unknown>>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(sql, { type: QueryTypes.SELECT, replacements });
  const statuses = async (type: string) =>
    (await rows<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM "Job" WHERE type = :type ORDER BY "createdAt", id`,
      { type },
    )) as Array<{ status: string; attempts: number }>;
  const waitFor = async (
    cond: () => boolean | Promise<boolean>,
    ms = 5_000,
  ) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error('waitFor timed out');
      await sleep(20);
    }
  };

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [RunHandlers] });
    h = t.get(RunHandlers);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h.executed.length = 0;
    h.started.length = 0;
    h.contexts.length = 0;
    h.abortReasons.length = 0;
    h.gate = new Gate();
  });

  it('S49 AS-10: 4 workers draining 1,000 due jobs run each exactly once', async () => {
    for (let i = 0; i < 1_000; i += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, k) =>
          t.jobs.enqueue('run.count', { n: i + k }),
        ),
      );
    const workers = [t.worker, t.newWorker(), t.newWorker(), t.newWorker()];
    const drain = async (w: (typeof workers)[number]) => {
      while ((await w.runOnce(50)) > 0);
    };
    await Promise.all(workers.map(drain));

    expect(h.executed).toHaveLength(1_000);
    expect(new Set(h.executed).size).toBe(1_000);
    expect(
      (await statuses('run.count')).every((j) => j.status === 'SUCCEEDED'),
    ).toBe(true);
    expect((await statuses('run.count')).every((j) => j.attempts === 1)).toBe(
      true,
    );
  }, 120_000);

  it('S49 AS-11: the oldest runAt is claimed first and a future job is left alone', async () => {
    const at = (minutes: number) =>
      new Date(t.clock.now().getTime() + minutes * 60_000);
    await t.jobs.enqueue('run.count', { n: 3 }, { runAt: at(-1) });
    await t.jobs.enqueue('run.count', { n: 1 }, { runAt: at(-3) });
    await t.jobs.enqueue('run.count', { n: 2 }, { runAt: at(-2) });
    await t.jobs.enqueue('run.count', { n: 9 }, { runAt: at(60) });

    expect(await t.worker.runOnce(2)).toBe(2);
    expect([...h.executed].sort()).toEqual([1, 2]);
    expect(await t.worker.runOnce(10)).toBe(1);
    expect(h.executed).toContain(3);
    expect(h.executed).not.toContain(9);
    expect(await t.worker.runOnce(10)).toBe(0);
  });

  it('S49 AS-12: a job whose type this worker has no handler for is not claimed', async () => {
    await t.jobs.enqueue('run.nohandler', { n: 1 });

    expect(await t.worker.runOnce()).toBe(0);
    expect(await statuses('run.nohandler')).toEqual([
      { status: 'QUEUED', attempts: 0 },
    ]);
  });

  it('S49 AS-13: concurrency is a per-worker bulkhead: no more than 3 of the type run at once', async () => {
    for (let i = 0; i < 10; i++) await t.jobs.enqueue('run.bulk', { n: i });

    const first = t.worker.runOnce();
    await waitFor(() => h.started.length === 3);
    expect(await t.worker.runOnce()).toBe(0); // no free slot for the type
    await sleep(200);
    expect(h.started).toHaveLength(3);
    expect(
      (await statuses('run.bulk')).filter((j) => j.status === 'RUNNING'),
    ).toHaveLength(3);

    h.gate.open();
    await first;
    expect(
      (await statuses('run.bulk')).filter((j) => j.status === 'QUEUED'),
    ).toHaveLength(7);
  });

  it('S49 AS-14: fleetConcurrency: 1 holds across 3 workers', async () => {
    for (let i = 0; i < 5; i++) await t.jobs.enqueue('run.fleet', { n: i });
    const workers = [t.worker, t.newWorker(), t.newWorker()];

    const runs = workers.map((w) => w.runOnce());
    await waitFor(() => h.started.length >= 1);
    await sleep(300);
    expect(h.started).toHaveLength(1);
    expect(
      (await statuses('run.fleet')).filter((j) => j.status === 'RUNNING'),
    ).toHaveLength(1);

    h.gate.open();
    await Promise.all(runs);
    expect(
      (await statuses('run.fleet')).filter((j) => j.status === 'SUCCEEDED'),
    ).toHaveLength(1);
  });

  it('S49 AS-15: the lease is the handler leaseMs from the moment of the claim', async () => {
    await t.jobs.enqueue('run.leased', { n: 1 });

    const run = t.worker.runOnce();
    await waitFor(() => h.started.length === 1);
    const [row] = await rows<{ lockedUntil: Date }>(
      `SELECT "lockedUntil" FROM "Job" WHERE type = 'run.leased'`,
    );
    expect(new Date(row.lockedUntil).getTime() - t.clock.now().getTime()).toBe(
      90_000,
    );

    h.gate.open();
    await run;
  });
});

describe('Job worker: outcomes (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let h: RunHandlers;

  const rows = <R extends object = Record<string, unknown>>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(sql, { type: QueryTypes.SELECT, replacements });
  const one = async (type: string) =>
    (
      await rows<Record<string, any>>(
        `SELECT * FROM "Job" WHERE type = :type ORDER BY "createdAt" DESC LIMIT 1`,
        { type },
      )
    )[0];
  const counter = (type: string, outcome: string) =>
    MetricsRegistry.value('job_outcomes_total', { type, outcome }) ?? 0;

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [RunHandlers] });
    h = t.get(RunHandlers);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h.executed.length = 0;
    h.started.length = 0;
    h.contexts.length = 0;
    h.abortReasons.length = 0;
  });

  it('S49 AS-16: success ends SUCCEEDED with the lock cleared and the counter raised', async () => {
    const before = counter('run.count', 'succeeded');
    await t.jobs.enqueue('run.count', { n: 1 });
    await t.worker.runOnce();

    const job = await one('run.count');
    expect(job).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      lockedBy: null,
      lockedUntil: null,
      lastError: null,
    });
    expect(job.finishedAt).not.toBeNull();
    expect(counter('run.count', 'succeeded')).toBe(before + 1);
  });

  it('S49 AS-17: a failure re-queues with a jittered runAt and the job succeeds on a later attempt', async () => {
    await t.jobs.enqueue('run.flaky', { failTimes: 1, key: 'a' });
    const start = t.clock.now().getTime();
    await t.worker.runOnce();

    const failed = await one('run.flaky');
    expect(failed).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lastError: 'transient #1',
    });
    const delay = new Date(failed.runAt).getTime() - start;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(retryCeilingMs(1));
    expect(failed.lockedBy).toBeNull();

    expect(await t.worker.runOnce()).toBe(0); // not due until runAt (unless the jitter was 0)
    t.clock.advance(retryCeilingMs(1) + 1);
    await t.worker.runOnce();
    expect(await one('run.flaky')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
  });

  it('S49 AS-19: when the attempts are used up the job is DEAD', async () => {
    await t.jobs.enqueue(
      'run.flaky',
      { failTimes: 99, key: 'b' },
      { maxAttempts: 2 },
    );
    await t.worker.runOnce();
    t.clock.advance(retryCeilingMs(1) + 1);
    await t.worker.runOnce();

    const job = await one('run.flaky');
    expect(job).toMatchObject({
      status: 'DEAD',
      attempts: 2,
      lastError: 'transient #2',
    });
    expect(job.finishedAt).not.toBeNull();
  });

  it('S49 AS-20: NonRetryableJobError ends the job DEAD at attempt 1', async () => {
    await t.jobs.enqueue('run.poison', {});
    await t.worker.runOnce();

    expect(await one('run.poison')).toMatchObject({
      status: 'DEAD',
      attempts: 1,
      lastError: 'payload references a deleted entity',
    });
  });

  it('S49 AS-21: a stored payload that breaks the contract goes DEAD without calling the handler', async () => {
    await t.sequelize.query(
      `INSERT INTO "Job" (type, payload, "runAt") VALUES ('run.count', '{"n":"not-a-number"}', :now)`,
      { replacements: { now: t.clock.now() } },
    );
    await t.worker.runOnce();

    const job = await one('run.count');
    expect(job.status).toBe('DEAD');
    expect(job.lastError).toBe('invalid payload: n');
    expect(h.executed).toEqual([]);
  });

  it('S49 AS-22: the handler context carries jobId, attempt, maxAttempts and isLastAttempt', async () => {
    const { id } = await t.jobs.enqueue(
      'run.ctx',
      { key: 'c' },
      { maxAttempts: 2 },
    );
    await t.worker.runOnce();
    t.clock.advance(retryCeilingMs(1) + 1);
    await t.worker.runOnce();

    expect(h.contexts).toEqual([
      { jobId: id, attempt: 1, maxAttempts: 2, isLastAttempt: false },
      { jobId: id, attempt: 2, maxAttempts: 2, isLastAttempt: true },
    ]);
  });

  it('S49 AS-23: lastError is cut at 2,000 characters and no log line contains the payload', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(JSON.stringify(args));
          }),
    );
    try {
      await t.jobs.enqueue('run.secret', { secret: 'TOP-SECRET-PAYLOAD' });
      await t.worker.runOnce();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect((await one('run.secret')).lastError).toHaveLength(2_000);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('TOP-SECRET-PAYLOAD');
  });

  it('S49 AS-24: running past maxRuntimeMs aborts the signal with reason timeout and the attempt is retried', async () => {
    const before = counter('run.timeout', 'timeout');
    await t.jobs.enqueue('run.timeout', { n: 1 });
    await t.worker.runOnce();

    expect(h.abortReasons).toEqual(['timeout']);
    const job = await one('run.timeout');
    expect(job).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lockedBy: null,
    });
    expect(job.lastError).toContain('maxRuntimeMs');
    expect(counter('run.timeout', 'timeout')).toBe(before + 1);
  }, 20_000);
});
