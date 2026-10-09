import { Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { QueryTypes } from 'sequelize';
import { v4 } from 'uuid';
import { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { sleep } from '@app/common/core/backoff';
import { RequestContext } from '@app/infrastructure/context';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import { InvalidCursorError } from './job-errors';
import { JobsAdminService } from './jobs-admin.service';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'obs.ok': { n: number };
    'obs.fail': { secret: string };
    'obs.ctx': { n: number };
  }
}
declareJobType({ name: 'obs.ok', contract: z.object({ n: z.number() }) });
declareJobType({
  name: 'obs.fail',
  contract: z.object({ secret: z.string() }),
});
declareJobType({ name: 'obs.ctx', contract: z.object({ n: z.number() }) });

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

@Injectable()
class ObsHandlers {
  constructor(readonly context: RequestContext) {}
  readonly seen: Array<{
    n: number;
    shopId?: string;
    requestId?: string;
    principal?: string;
    traceparent?: string;
  }> = [];
  barrier!: Promise<void>;
  release!: () => void;

  reset() {
    this.seen.length = 0;
    this.barrier = new Promise((resolve) => (this.release = resolve));
  }

  @JobHandler('obs.ok')
  async ok() {}

  @JobHandler('obs.fail')
  async fail() {
    throw new Error('boom');
  }

  @JobHandler('obs.ctx', { concurrency: 5 })
  async ctx({ n }: { n: number }) {
    await this.barrier; // both jobs are inside their handler when they read the context
    this.seen.push({
      n,
      shopId: this.context.shopId,
      requestId: this.context.requestId,
      principal: (this.context.snapshot() as { principalType?: string })
        .principalType,
      traceparent: (this.context.snapshot() as { traceparent?: string })
        .traceparent,
    });
  }
}

describe('Job observability and operator views (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let admin: JobsAdminService;
  let h: ObsHandlers;
  const reader = new TestReader();

  const sql = <R extends object = Record<string, any>>(
    text: string,
    replacements: Record<string, unknown> = {},
  ) => t.sequelize.query<R>(text, { type: QueryTypes.SELECT, replacements });
  const lag = (type?: string) =>
    MetricsRegistry.value('job_queue_lag_seconds', type ? { type } : {});

  beforeAll(async () => {
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
    t = await createJobsTestApp({ providers: [ObsHandlers] });
    admin = t.get(JobsAdminService);
    h = t.get(ObsHandlers);
  });
  afterAll(async () => {
    h.release?.();
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h.reset();
  });

  it('S49 AS-77: queue lag is published per type on every tick and is 0 when nothing is due', async () => {
    const ago = (s: number) => new Date(t.clock.now().getTime() - s * 1_000);
    await t.jobs.enqueue('obs.ok', { n: 1 }, { runAt: ago(30) });
    await t.jobs.enqueue('obs.fail', { secret: 'x' }, { runAt: ago(5) });
    await t.jobs.enqueue(
      'obs.ok',
      { n: 2 },
      { runAt: new Date(t.clock.now().getTime() + 600_000) },
    );

    await t.maintenance.tick();
    expect(lag('obs.ok')).toBe(30);
    expect(lag('obs.fail')).toBe(5);
    expect(lag()).toBe(30);

    t.clock.advance(10_000); // the very next tick sees the new value, not every tenth
    await t.maintenance.tick();
    expect(lag('obs.ok')).toBe(40);

    await t.worker.runOnce();
    await t.maintenance.tick();
    expect(lag('obs.ok')).toBe(0);
    expect(lag()).toBe(0);
  });

  it('S49 AS-78: outcome counters, the duration histogram and the dead-jobs gauge are published', async () => {
    const outcome = (type: string, o: string) =>
      MetricsRegistry.value('job_outcomes_total', { type, outcome: o }) ?? 0;
    const okBefore = outcome('obs.ok', 'succeeded');
    const retryBefore = outcome('obs.fail', 'retry');
    const deadBefore = outcome('obs.fail', 'dead');

    await t.jobs.enqueue('obs.ok', { n: 1 });
    await t.jobs.enqueue('obs.fail', { secret: 's' }, { maxAttempts: 2 });
    await t.worker.runOnce();
    t.clock.advance(20 * 60_000);
    await t.worker.runOnce();
    await t.maintenance.publishDeadGauge();

    expect(outcome('obs.ok', 'succeeded')).toBe(okBefore + 1);
    expect(outcome('obs.fail', 'retry')).toBe(retryBefore + 1);
    expect(outcome('obs.fail', 'dead')).toBe(deadBefore + 1);
    expect(MetricsRegistry.value('job_dead_jobs', { type: 'obs.fail' })).toBe(
      1,
    );

    const { resourceMetrics } = await reader.collect();
    const duration = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'job_duration_ms');
    expect(duration).toBeDefined();
    const types = (
      duration!.dataPoints as Array<{ attributes: { type?: string } }>
    ).map((p) => p.attributes.type);
    expect(types).toEqual(expect.arrayContaining(['obs.ok', 'obs.fail']));

    await sql(`UPDATE "Job" SET status = 'SUCCEEDED'`);
    await t.maintenance.publishDeadGauge();
    expect(MetricsRegistry.value('job_dead_jobs', { type: 'obs.fail' })).toBe(
      0,
    );
  });

  it('S49 AS-79: expired leases and skipped schedule fires are counted', async () => {
    const expired = () =>
      MetricsRegistry.value('job_lease_expired_total', { type: 'obs.ok' }) ?? 0;
    const before = expired();
    await sql(
      `INSERT INTO "Job" (type, payload, status, "runAt", attempts, "lockedBy", "lockedUntil")
       VALUES ('obs.ok', '{"n":1}', 'RUNNING', :now, 1, 'gone', :past)`,
      { now: t.clock.now(), past: new Date(t.clock.now().getTime() - 1_000) },
    );
    await t.reaper.reap();
    expect(expired()).toBe(before + 1);

    await t.jobs.upsertSchedule({
      name: 'skipper',
      cron: '0 * * * *',
      jobType: 'obs.ok',
      payload: { n: 1 },
    });
    const skipped = () =>
      MetricsRegistry.value('cron_fires_skipped_total', {
        schedule: 'skipper',
      }) ?? 0;
    const skippedBefore = skipped();
    t.clock.advance(3_600_000);
    await t.maintenance.materializeDueSchedules();
    t.clock.advance(3_600_000);
    await t.maintenance.materializeDueSchedules();
    expect(skipped()).toBe(skippedBefore + 1);
    expect(MetricsRegistry.value('cron_leader')).toBe(1);
  });

  it('S49 AS-80: log lines about a job are structured, carry the ids and never the payload', async () => {
    const lines: unknown[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        lines.push(args[0]);
      });
    const shopId = v4();
    const traceparent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const ctx = t.get<RequestContext>(RequestContext);
    let jobId = '';
    try {
      jobId = (
        await ctx.run({ requestId: 'req-origin', traceparent }, () =>
          t.jobs.enqueue('obs.fail', { secret: 'PAYLOAD-SECRET' }, { shopId }),
        )
      ).id;
      await t.worker.runOnce();
    } finally {
      spy.mockRestore();
    }

    const line = lines.find(
      (l) => (l as { jobId?: string })?.jobId === jobId,
    ) as Record<string, unknown>;
    expect(line).toMatchObject({
      jobId,
      type: 'obs.fail',
      attempt: 1,
      shopId,
      requestId: `job:${jobId}`,
      enqueuedByRequestId: 'req-origin',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    });
    expect(JSON.stringify(lines)).not.toContain('PAYLOAD-SECRET');
  });

  it('S49 AS-81: two concurrent jobs each see their own shop, request id, principal and trace', async () => {
    const shopA = v4();
    const shopB = v4();
    const traceparent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const ctx = t.get<RequestContext>(RequestContext);
    const a = await ctx.run({ requestId: 'ra', traceparent }, () =>
      t.jobs.enqueue('obs.ctx', { n: 1 }, { shopId: shopA }),
    );
    const b = await t.jobs.enqueue('obs.ctx', { n: 2 }, { shopId: shopB });

    const run = t.worker.runOnce();
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Job" WHERE status = 'RUNNING'`,
      );
      if (n === 2) break;
      await sleep(20);
    }
    h.release();
    await run;

    expect(h.seen.find((s) => s.n === 1)).toEqual({
      n: 1,
      shopId: shopA,
      requestId: `job:${a.id}`,
      principal: 'service',
      traceparent,
    });
    expect(h.seen.find((s) => s.n === 2)).toMatchObject({
      n: 2,
      shopId: shopB,
      requestId: `job:${b.id}`,
      principal: 'service',
    });
    expect(h.seen).toHaveLength(2);
  });

  describe('listJobs and getStats', () => {
    const seed = async (
      count: number,
      type = 'obs.ok',
      shopId?: string,
      status = 'QUEUED',
    ) => {
      await sql(
        `INSERT INTO "Job" (type, payload, status, "runAt", "shopId", "createdAt")
         SELECT :type, '{"n":1}', :status, :now, :shopId, :now::timestamptz + i * interval '1 millisecond'
         FROM generate_series(1, :count) i`,
        { type, status, now: t.clock.now(), shopId: shopId ?? null, count },
      );
    };

    it('S49 AS-82: pages newest first with an opaque cursor, no gaps or repeats; the limit is clamped; no payload', async () => {
      await seed(130);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await admin.listJobs({}, { cursor });
        expect(page.items.length).toBeLessThanOrEqual(50);
        for (const item of page.items) {
          expect(item).not.toHaveProperty('payload');
          seen.push(item.id);
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(130);
      const expected = (
        await sql<{ id: string }>(
          `SELECT id FROM "Job" ORDER BY "createdAt" DESC, id DESC`,
        )
      ).map((r) => r.id);
      expect(seen).toEqual(expected);

      expect((await admin.listJobs({}, { limit: 500 })).items).toHaveLength(
        100,
      );
      expect((await admin.listJobs({}, { limit: 0 })).items).toHaveLength(1);
      const first = await admin.listJobs({}, { limit: 100 });
      expect(first.nextCursor).toBeDefined();
      const rest = await admin.listJobs(
        {},
        { limit: 100, cursor: first.nextCursor },
      );
      expect(rest.items).toHaveLength(30);
      expect(rest.nextCursor).toBeUndefined();
    });

    it('S49 AS-82: a tampered cursor is rejected and the filters narrow the list', async () => {
      const shop = v4();
      await seed(3, 'obs.ok', shop);
      await seed(2, 'obs.fail', undefined, 'DEAD');
      const { nextCursor } = await admin.listJobs({}, { limit: 1 });

      await expect(
        admin.listJobs({}, { cursor: nextCursor!.slice(0, -2) + 'xx' }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(
        admin.listJobs({}, { cursor: 'garbage' }),
      ).rejects.toBeInstanceOf(InvalidCursorError);

      expect((await admin.listJobs({ shopId: shop })).items).toHaveLength(3);
      expect((await admin.listJobs({ status: 'DEAD' })).items).toHaveLength(2);
      expect(
        (await admin.listJobs({ type: 'obs.fail', status: 'DEAD' })).items,
      ).toHaveLength(2);
      expect(
        (await admin.listJobs({ type: 'obs.ok', status: 'DEAD' })).items,
      ).toHaveLength(0);
    });

    it('S49 AS-83: getStats equals the row counts per type and status', async () => {
      await seed(4, 'obs.ok', undefined, 'QUEUED');
      await seed(2, 'obs.ok', undefined, 'SUCCEEDED');
      await seed(1, 'obs.fail', undefined, 'DEAD');
      await sql(
        `UPDATE "Job" SET "runAt" = :old WHERE type = 'obs.ok' AND status = 'QUEUED'`,
        {
          old: new Date(t.clock.now().getTime() - 90_000),
        },
      );

      const stats = await admin.getStats();

      const ok = stats.find((s) => s.type === 'obs.ok')!;
      expect(ok.counts).toEqual({
        QUEUED: 4,
        RUNNING: 0,
        SUCCEEDED: 2,
        DEAD: 0,
        CANCELLED: 0,
      });
      expect(ok.lagSeconds).toBe(90);
      expect(ok.oldestDueRunAt?.getTime()).toBe(
        t.clock.now().getTime() - 90_000,
      );
      const fail = stats.find((s) => s.type === 'obs.fail')!;
      expect(fail.counts.DEAD).toBe(1);
      expect(fail.lagSeconds).toBe(0);
      const total = stats
        .flatMap((s) => Object.values(s.counts))
        .reduce((a, b) => a + b, 0);
      expect(total).toBe(
        Number((await sql(`SELECT count(*)::int AS n FROM "Job"`))[0].n),
      );
    });
  });
});
