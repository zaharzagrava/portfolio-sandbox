import { Injectable, Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { sleep } from '@app/common/core/backoff';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import type { JobContext } from './job-types';
import { retryCeilingMs } from './backoff';
import { JobReaper } from './job-reaper.service';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'lease.gated': { key: string };
    'lease.hb': { key: string };
    'lease.sig': { key: string };
    'lease.timeout': { key: string };
    'lease.quick': { key: string };
  }
}

const key = z.object({ key: z.string() });
for (const name of [
  'lease.gated',
  'lease.hb',
  'lease.sig',
  'lease.timeout',
  'lease.quick',
] as const)
  declareJobType({ name, contract: key });

class Latches {
  private readonly all = new Map<
    string,
    { promise: Promise<void>; open: () => void }
  >();
  private entry(name: string) {
    let e = this.all.get(name);
    if (!e) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      e = { promise, open };
      this.all.set(name, e);
    }
    return e;
  }
  wait(name: string) {
    return this.entry(name).promise;
  }
  open(name: string) {
    this.entry(name).open();
  }
  openAll() {
    for (const e of this.all.values()) e.open();
  }
  clear() {
    this.openAll();
    this.all.clear();
  }
}

@Injectable()
class LeaseHandlers {
  readonly latches = new Latches();
  readonly starts: Array<{ key: string; attempt: number }> = [];
  readonly finished: Array<{ key: string; attempt: number }> = [];
  readonly reasons: unknown[] = [];
  readonly heartbeatErrors: string[] = [];

  /** Runs until the test opens the latch `<key>#<attempt>`; ignores the stop signal like a stuck handler. */
  @JobHandler('lease.gated', { concurrency: 50 })
  async gated({ key }: { key: string }, ctx: JobContext) {
    this.starts.push({ key, attempt: ctx.attempt });
    await this.latches.wait(`${key}#${ctx.attempt}`);
    this.finished.push({ key, attempt: ctx.attempt });
  }

  @JobHandler('lease.hb')
  async hb({ key }: { key: string }, ctx: JobContext) {
    this.starts.push({ key, attempt: ctx.attempt });
    await this.latches.wait(`${key}:hb`);
    try {
      await ctx.heartbeat();
    } catch (error) {
      this.heartbeatErrors.push((error as Error).name);
    }
    this.reasons.push(ctx.signal.reason);
    await this.latches.wait(`${key}:done`);
  }

  /** Cooperates: returns as soon as the signal aborts and records why. */
  @JobHandler('lease.sig')
  async sig({ key }: { key: string }, ctx: JobContext) {
    this.starts.push({ key, attempt: ctx.attempt });
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    this.reasons.push(ctx.signal.reason);
  }

  @JobHandler('lease.quick')
  async quick({ key }: { key: string }, ctx: JobContext) {
    this.starts.push({ key, attempt: ctx.attempt });
    this.finished.push({ key, attempt: ctx.attempt });
  }

  @JobHandler('lease.timeout', { leaseMs: 5_000, maxRuntimeMs: 5_000 })
  async timeout({ key }: { key: string }, ctx: JobContext) {
    this.starts.push({ key, attempt: ctx.attempt });
    await this.latches.wait(`${key}#${ctx.attempt}`);
    this.finished.push({ key, attempt: ctx.attempt });
  }
}

describe('Job leases, fencing, reaper and shutdown (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let h: LeaseHandlers;

  const rows = <R extends object = Record<string, any>>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(sql, { type: QueryTypes.SELECT, replacements });
  const job = async (type: string) =>
    (
      await rows<Record<string, any>>(
        `SELECT * FROM "Job" WHERE type = :type ORDER BY "createdAt" DESC LIMIT 1`,
        { type },
      )
    )[0];
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
  const LEASE = 60_000;
  const logSpies = () => {
    const calls: Array<{ level: string; args: unknown[] }> = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          calls.push({ level, args });
        }),
    );
    return { calls, restore: () => spies.forEach((s) => s.mockRestore()) };
  };

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [LeaseHandlers] });
    h = t.get(LeaseHandlers);
  });
  afterAll(async () => {
    h.latches.clear();
    await t.close();
  });
  beforeEach(async () => {
    h.latches.clear();
    await t.reset();
    h.starts.length = 0;
    h.finished.length = 0;
    h.reasons.length = 0;
    h.heartbeatErrors.length = 0;
  });
  afterEach(() => h.latches.openAll());

  it('S49 AS-25: a handler that finishes after its timeout cannot overwrite the retry', async () => {
    await t.jobs.enqueue('lease.timeout', { key: 'a' });
    await t.worker.runOnce(); // times out after 5 s; the handler is still stuck

    expect(await job('lease.timeout')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
    });
    h.latches.open('a#1'); // the stuck handler finally returns
    await waitFor(() => h.finished.length === 1);
    await sleep(100);

    expect(await job('lease.timeout')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lockedBy: null,
    });
  }, 20_000);

  it('S49 AS-26: a completion write refused twice is retried and applied on the third try', async () => {
    const real = t.sequelize.query.bind(t.sequelize) as (
      ...a: any[]
    ) => Promise<unknown>;
    let refused = 0;
    const spy = jest.spyOn(t.sequelize, 'query').mockImplementation(((
      sql: string,
      options?: any,
    ) => {
      if (options?.replacements?.to === 'SUCCEEDED' && refused < 2) {
        refused++;
        return Promise.reject(new Error('connection reset'));
      }
      return real(sql, options);
    }) as never);
    try {
      await t.jobs.enqueue('lease.quick', { key: 'q' });
      await t.worker.runOnce();
    } finally {
      spy.mockRestore();
    }

    expect(refused).toBe(2);
    expect(await job('lease.quick')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
    });
  });

  it('S49 AS-26: when all three completion writes fail the job is left to the reaper and an error is logged', async () => {
    const real = t.sequelize.query.bind(t.sequelize) as (
      ...a: any[]
    ) => Promise<unknown>;
    let refuse = true;
    const spy = jest.spyOn(t.sequelize, 'query').mockImplementation(((
      sql: string,
      options?: any,
    ) => {
      if (refuse && options?.replacements?.to === 'SUCCEEDED')
        return Promise.reject(new Error('connection reset'));
      return real(sql, options);
    }) as never);
    const logs = logSpies();
    const { id } = await t.jobs.enqueue('lease.quick', { key: 'q2' });
    try {
      await t.worker.runOnce();
    } finally {
      refuse = false;
      spy.mockRestore();
      logs.restore();
    }

    expect(await job('lease.quick')).toMatchObject({
      status: 'RUNNING',
      attempts: 1,
    });
    const errors = logs.calls.filter((c) => c.level === 'error');
    expect(JSON.stringify(errors)).toContain(id);

    t.clock.advance(LEASE + 1);
    expect(await t.reaper.reap()).toBe(1);
    t.clock.advance(retryCeilingMs(1) + 1);
    await t.worker.runOnce();
    expect(await job('lease.quick')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
    expect(h.finished).toHaveLength(2); // at-least-once: it ran twice
  });

  it('S49 AS-27: an expired lease is reaped, the job runs again and the attempts are counted', async () => {
    await t.jobs.enqueue('lease.gated', { key: 'dead-worker' });
    const stuck = t.newWorker().runOnce(); // a worker that dies holding the job
    await waitFor(() => h.starts.length === 1);

    expect(await t.reaper.reap()).toBe(0); // lease still valid
    t.clock.advance(LEASE + 1);
    expect(await t.reaper.reap()).toBe(1);
    expect(await job('lease.gated')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      lockedBy: null,
    });
    expect((await job('lease.gated')).lastError).toBe('[lease expired]');

    t.clock.advance(retryCeilingMs(1) + 1);
    h.latches.open('dead-worker#2');
    await t.worker.runOnce();
    expect(await job('lease.gated')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });

    h.latches.open('dead-worker#1');
    await stuck;
  });

  it('S49 AS-28: a job that kills every worker ends DEAD through the reaper, with one marker and no hot loop', async () => {
    await t.jobs.enqueue('lease.gated', { key: 'killer' }, { maxAttempts: 3 });
    const stuck: Promise<number>[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      t.clock.advance(retryCeilingMs(attempt) + 1);
      stuck.push(t.newWorker().runOnce());
      await waitFor(() => h.starts.length === attempt);
      t.clock.advance(LEASE + 1);
      expect(await t.reaper.reap()).toBe(1);
    }

    const dead = await job('lease.gated');
    expect(dead).toMatchObject({ status: 'DEAD', attempts: 3 });
    expect(dead.finishedAt).not.toBeNull();
    expect(dead.lastError.match(/\[lease expired\]/g)).toHaveLength(1);
    expect(await t.reaper.reap()).toBe(0);
    t.clock.advance(3_600_000);
    expect(await t.worker.runOnce()).toBe(0);
    h.latches.openAll();
    await Promise.all(stuck);
  });

  it('S49 AS-29: a heartbeat keeps a long job alive past its original lease', async () => {
    await t.jobs.enqueue('lease.hb', { key: 'long' });
    const run = t.worker.runOnce();
    await waitFor(() => h.starts.length === 1);

    t.clock.advance(50_000);
    h.latches.open('long:hb');
    await waitFor(() => h.reasons.length === 1);
    t.clock.advance(50_000); // 100 s after the claim: the first lease (60 s) is over, the extended one (110 s) is not
    expect(await t.reaper.reap()).toBe(0);
    expect(await job('lease.hb')).toMatchObject({
      status: 'RUNNING',
      attempts: 1,
    });
    expect(h.heartbeatErrors).toEqual([]);

    h.latches.open('long:done');
    await run;
    expect(await job('lease.hb')).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('S49 AS-30: a zombie worker finishing after another worker re-claimed the job changes nothing', async () => {
    await t.jobs.enqueue('lease.gated', { key: 'zombie' });
    const zombie = t.newWorker().runOnce();
    await waitFor(() => h.starts.length === 1);
    t.clock.advance(LEASE + 1);
    await t.reaper.reap();
    t.clock.advance(retryCeilingMs(1) + 1);
    const second = t.newWorker().runOnce();
    await waitFor(() => h.starts.length === 2);

    h.latches.open('zombie#1'); // the zombie reports success
    await zombie;
    expect(await job('lease.gated')).toMatchObject({
      status: 'RUNNING',
      attempts: 2,
    });

    h.latches.open('zombie#2');
    await second;
    expect(await job('lease.gated')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
  });

  it('S49 AS-31: when the same worker claims the job again, the old execution is fenced by the attempt number', async () => {
    await t.jobs.enqueue('lease.gated', { key: 'same' });
    const w = t.newWorker();
    const first = w.runOnce();
    await waitFor(() => h.starts.length === 1);
    t.clock.advance(LEASE + 1);
    await t.reaper.reap();
    t.clock.advance(retryCeilingMs(1) + 1);
    const second = w.runOnce(); // same worker id, attempt 2
    await waitFor(() => h.starts.length === 2);

    h.latches.open('same#1');
    await first;
    expect(await job('lease.gated')).toMatchObject({
      status: 'RUNNING',
      attempts: 2,
    });

    h.latches.open('same#2');
    await second;
    expect(await job('lease.gated')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
    });
  });

  it('S49 AS-32: a heartbeat after the lease was lost aborts the signal with reason lease_lost', async () => {
    await t.jobs.enqueue('lease.hb', { key: 'lost' });
    const run = t.worker.runOnce();
    await waitFor(() => h.starts.length === 1);
    t.clock.advance(LEASE + 1);
    await t.reaper.reap(); // someone else's reaper took the lease away

    h.latches.open('lost:hb');
    await waitFor(() => h.reasons.length === 1);
    expect(h.heartbeatErrors).toEqual(['LeaseLostError']);
    expect(h.reasons).toEqual(['lease_lost']);
    expect(await job('lease.hb')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
    });

    h.latches.open('lost:done');
    await run;
    expect(await job('lease.hb')).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
    }); // nothing written by the loser
  });

  it('S49 AS-33: two reapers at once reap each expired job exactly once', async () => {
    await t.sequelize.query(
      `INSERT INTO "Job" (type, payload, status, "runAt", attempts, "maxAttempts", "lockedBy", "lockedUntil")
       SELECT 'lease.quick', '{"key":"x"}', 'RUNNING', :now, 1, 8, 'gone', :expired FROM generate_series(1, 200)`,
      {
        replacements: {
          now: t.clock.now(),
          expired: new Date(t.clock.now().getTime() - 1_000),
        },
      },
    );
    const second = new JobReaper(t.sequelize, t.clock);

    const [a, b] = await Promise.all([t.reaper.reap(), second.reap()]);

    expect(a + b).toBe(200);
    const after = await rows<{ status: string; attempts: number; n: number }>(
      `SELECT status, attempts, count(*)::int AS n FROM "Job" GROUP BY 1, 2`,
    );
    expect(after).toEqual([{ status: 'QUEUED', attempts: 1, n: 200 }]);
    expect(
      MetricsRegistry.value('job_lease_expired_total', { type: 'lease.quick' }),
    ).toBeGreaterThanOrEqual(200);
  });

  it('S49 AS-34: a graceful shutdown lets in-flight jobs finish', async () => {
    await t.jobs.enqueue('lease.gated', { key: 'drain' });
    const w = t.newWorker();
    const run = w.runOnce();
    await waitFor(() => h.starts.length === 1);

    let stopped = false;
    const stopping = w.stop().then(() => (stopped = true));
    await sleep(150);
    expect(stopped).toBe(false); // waiting for the job

    h.latches.open('drain#1');
    await stopping;
    await run;
    expect(await job('lease.gated')).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
    });
  });

  it('S49 AS-35: past the drain deadline the signal aborts with shutdown and the job is released with its attempt refunded', async () => {
    const before =
      MetricsRegistry.value('job_outcomes_total', {
        type: 'lease.sig',
        outcome: 'released',
      }) ?? 0;
    await t.jobs.enqueue('lease.sig', { key: 'slow' });
    const w = t.newWorker();
    const run = w.runOnce();
    await waitFor(() => h.starts.length === 1);

    await w.stop(300); // drain deadline 300 ms instead of 25 s
    await run;

    expect(h.reasons).toEqual(['shutdown']);
    const released = await job('lease.sig');
    expect(released).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
    });
    expect(new Date(released.runAt).getTime()).toBe(t.clock.now().getTime());
    expect(
      MetricsRegistry.value('job_outcomes_total', {
        type: 'lease.sig',
        outcome: 'released',
      }),
    ).toBe(before + 1);

    // picked up at once by another worker, without waiting for a lease to run out
    const other = t.newWorker();
    const again = other.runOnce();
    await waitFor(() => h.starts.length === 2);
    await other.stop(100);
    await again;
  });

  it('S49 AS-36: nothing is claimed once shutdown has begun', async () => {
    await t.jobs.enqueue('lease.quick', { key: 'late' });
    const w = t.newWorker();
    await w.stop();

    expect(await w.runOnce()).toBe(0);
    expect(await job('lease.quick')).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
    });
  });

  it('S49 AS-37: a database outage does not stop the loops; they resume when the database is back', async () => {
    const logs = logSpies();
    const w = t.newWorker();
    const m = t.newMaintenance();
    const realQuery = t.sequelize.query.bind(t.sequelize) as (
      ...a: any[]
    ) => Promise<unknown>;
    const runner = t.get<TransactionRunner>(TransactionRunner);
    const realRun = runner.run.bind(runner) as (
      ...a: any[]
    ) => Promise<unknown>;
    let down = true;
    const outage = new Error('connect ECONNREFUSED');
    const q = jest
      .spyOn(t.sequelize, 'query')
      .mockImplementation(((...a: any[]) =>
        down ? Promise.reject(outage) : realQuery(...a)) as never);
    const tx = jest
      .spyOn(runner, 'run')
      .mockImplementation(((...a: any[]) =>
        down ? Promise.reject(outage) : realRun(...a)) as never);
    try {
      w.startLoop();
      m.startLoop();
      await sleep(1_500);
      expect(
        logs.calls.filter((c) => c.level === 'error').length,
      ).toBeGreaterThan(0);

      down = false; // the database is back
      q.mockImplementation(((...a: any[]) => realQuery(...a)) as never);
      tx.mockImplementation(((...a: any[]) => realRun(...a)) as never);
      await t.jobs.enqueue('lease.quick', { key: 'after-outage' });
      await waitFor(
        async () => (await job('lease.quick'))?.status === 'SUCCEEDED',
        20_000,
      );
    } finally {
      q.mockRestore();
      tx.mockRestore();
      logs.restore();
      await w.stop();
      await m.stop();
    }
    expect(h.finished.map((f) => f.key)).toContain('after-outage');
  }, 40_000);
});
