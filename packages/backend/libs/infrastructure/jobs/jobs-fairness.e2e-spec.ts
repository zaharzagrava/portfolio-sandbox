import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { v4 } from 'uuid';
import { z } from 'zod';
import { sleep } from '@app/common/core/backoff';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'fair.work': { n: number; hold?: boolean };
  }
}
declareJobType({
  name: 'fair.work',
  contract: z.object({ n: z.number(), hold: z.boolean().optional() }),
});

class Gate {
  private release!: () => void;
  readonly opened = new Promise<void>((resolve) => (this.release = resolve));
  open() {
    this.release();
  }
}

@Injectable()
class FairHandlers {
  readonly started: number[] = [];
  readonly executed: number[] = [];
  gate = new Gate();

  @JobHandler('fair.work', { concurrency: 500 })
  async work({ n, hold }: { n: number; hold?: boolean }) {
    this.started.push(n);
    if (hold) await this.gate.opened;
    this.executed.push(n);
  }
}

describe('Per-shop fairness (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let h: FairHandlers;
  const CAP = 5;

  const running = async (shopId?: string) =>
    Number(
      (
        await t.sequelize.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "Job" WHERE status = 'RUNNING' AND (:shopId IS NULL OR "shopId" = :shopId)`,
          { type: QueryTypes.SELECT, replacements: { shopId: shopId ?? null } },
        )
      )[0].n,
    );
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
  const enqueueMany = async (
    shopId: string | undefined,
    from: number,
    count: number,
    hold = false,
    runAt?: Date,
  ) => {
    for (let i = 0; i < count; i += 25)
      await Promise.all(
        Array.from({ length: Math.min(25, count - i) }, (_, k) =>
          t.jobs.enqueue(
            'fair.work',
            { n: from + i + k, hold },
            { shopId, runAt },
          ),
        ),
      );
  };

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [FairHandlers] });
    h = t.get(FairHandlers);
  });
  afterAll(async () => {
    h.gate.open();
    await t.close();
  });
  beforeEach(async () => {
    h.gate.open();
    await t.reset();
    h.started.length = 0;
    h.executed.length = 0;
    h.gate = new Gate();
    t.config.set('jobs_per_shop_running_cap', CAP);
  });

  it('S49 AS-46: the per-shop cap holds fleet-wide while a shop with a big backlog is drained', async () => {
    const shop = v4();
    await enqueueMany(shop, 0, 60, true);
    const workers = [t.worker, t.newWorker(), t.newWorker()];
    let peak = 0;
    const sampler = setInterval(() => {
      void running(shop).then((n) => (peak = Math.max(peak, n)));
    }, 5);

    try {
      let remaining = 60;
      while (remaining > 0) {
        const round = Promise.all(workers.map((w) => w.runOnce(50)));
        await waitFor(async () => (await running(shop)) > 0);
        await sleep(100);
        expect(await running(shop)).toBeLessThanOrEqual(CAP);
        h.gate.open();
        remaining -= (await round).reduce((a, b) => a + b, 0);
        h.gate = new Gate();
      }
    } finally {
      clearInterval(sampler);
      h.gate.open();
    }

    expect(peak).toBeLessThanOrEqual(CAP);
    expect(peak).toBeGreaterThan(0);
    expect(h.executed).toHaveLength(60);
  }, 60_000);

  it('S49 AS-47: a shop at its cap does not delay another shop', async () => {
    const busy = v4();
    const quiet = v4();
    await enqueueMany(
      busy,
      0,
      200,
      true,
      new Date(t.clock.now().getTime() - 3_600_000),
    );
    const first = t.worker.runOnce(50);
    await waitFor(() => h.started.length === CAP);

    await t.jobs.enqueue(
      'fair.work',
      { n: 1_000, hold: false },
      { shopId: quiet },
    );
    expect(await t.newWorker().runOnce(50)).toBe(1); // the next poll skips the saturated shop
    expect(h.executed).toEqual([1_000]);
    expect(await running(busy)).toBe(CAP);

    h.gate.open();
    await first;
  });

  it('S49 AS-48: the cap counts the jobs claimed in the same batch', async () => {
    const shop = v4();
    h.gate.open();
    await enqueueMany(shop, 0, 20);

    expect(await t.worker.runOnce(50)).toBe(CAP);
    expect(h.executed).toHaveLength(CAP);
  });

  it('S49 AS-49: four claimers polling at the same moment still keep the cap', async () => {
    const shop = v4();
    await enqueueMany(shop, 0, 40, true);
    const workers = [t.worker, t.newWorker(), t.newWorker(), t.newWorker()];

    const round = Promise.all(workers.map((w) => w.runOnce(50)));
    await waitFor(async () => (await running(shop)) > 0);
    await sleep(150);
    expect(await running(shop)).toBe(CAP);
    h.gate.open();
    expect((await round).reduce((a, b) => a + b, 0)).toBe(CAP);
  });

  it('S49 AS-50: jobs without a shop are not capped', async () => {
    h.gate.open();
    await enqueueMany(undefined, 0, 20);

    expect(await t.worker.runOnce(50)).toBe(20);
  });

  it('S49 AS-51: finishing a job frees a slot on the next poll', async () => {
    const shop = v4();
    h.gate.open();
    await enqueueMany(shop, 0, 8);

    expect(await t.worker.runOnce(50)).toBe(5);
    expect(await t.worker.runOnce(50)).toBe(3);
    expect(await t.worker.runOnce(50)).toBe(0);
  });

  it('S49 AS-52: among shops below their cap the oldest jobs go first', async () => {
    h.gate.open();
    const shops = [v4(), v4(), v4()];
    const base = t.clock.now().getTime() - 3_600_000;
    for (let i = 0; i < 9; i++)
      await t.jobs.enqueue(
        'fair.work',
        { n: i },
        { shopId: shops[i % 3], runAt: new Date(base + i * 1_000) },
      );

    expect(await t.worker.runOnce(4)).toBe(4);
    expect([...h.executed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
