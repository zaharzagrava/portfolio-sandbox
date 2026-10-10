import { Injectable, Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { v4 } from 'uuid';
import { z } from 'zod';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import { JobsAdminService } from './jobs-admin.service';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'state.work': { n: number };
  }
}
declareJobType({ name: 'state.work', contract: z.object({ n: z.number() }) });

@Injectable()
class StateHandlers {
  readonly executed: number[] = [];

  @JobHandler('state.work')
  async work({ n }: { n: number }) {
    this.executed.push(n);
  }
}

describe('Job cancel and operator retry (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let h: StateHandlers;
  let admin: JobsAdminService;

  const row = async (id: string) =>
    (
      await t.sequelize.query<Record<string, any>>(
        `SELECT * FROM "Job" WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      )
    )[0];
  const insert = async (status: string) => {
    const [r] = await t.sequelize.query<{ id: string }>(
      `INSERT INTO "Job" (type, payload, status, "runAt", attempts, "finishedAt")
       VALUES ('state.work', '{"n":1}', :status, :now, 3,
               CASE WHEN :status IN ('QUEUED', 'RUNNING') THEN NULL ELSE CAST(:now AS timestamptz) END)
       RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { status, now: t.clock.now() } },
    );
    return r.id;
  };

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [StateHandlers] });
    h = t.get(StateHandlers);
    admin = t.get(JobsAdminService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    h.executed.length = 0;
  });

  it('S49 AS-39: cancelling a QUEUED job ends it CANCELLED', async () => {
    const { id } = await t.jobs.enqueue('state.work', { n: 1 });

    expect(await t.jobs.cancel(id)).toEqual({ outcome: 'CANCELLED' });

    const job = await row(id);
    expect(job.status).toBe('CANCELLED');
    expect(job.finishedAt).not.toBeNull();
    expect(await t.worker.runOnce()).toBe(0);
  });

  it.each(['RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED'])(
    'S49 AS-40: cancelling a %s job is a CONFLICT and changes nothing',
    async (status) => {
      const id = await insert(status);

      expect(await t.jobs.cancel(id)).toEqual({ outcome: 'CONFLICT', status });
      expect((await row(id)).status).toBe(status);
    },
  );

  it('S49 AS-40: cancelling an unknown job is NOT_FOUND', async () => {
    expect(await t.jobs.cancel(v4())).toEqual({ outcome: 'NOT_FOUND' });
  });

  it('S49 AS-41: cancel and claim race: every job is either cancelled or run, never both', async () => {
    const results: Array<{ cancelled: boolean; status: string; ran: boolean }> =
      [];
    for (let i = 0; i < 25; i++) {
      h.executed.length = 0;
      const { id } = await t.jobs.enqueue('state.work', { n: i });
      const [cancel] = await Promise.all([
        t.jobs.cancel(id),
        t.worker.runOnce(),
      ]);
      results.push({
        cancelled: cancel.outcome === 'CANCELLED',
        status: (await row(id)).status,
        ran: h.executed.includes(i),
      });
    }

    for (const r of results) {
      if (r.cancelled)
        expect(r).toMatchObject({ status: 'CANCELLED', ran: false });
      else expect(r).toMatchObject({ status: 'SUCCEEDED', ran: true });
    }
  });

  it('S49 AS-42: cancelByKey cancels the job behind an idempotency key', async () => {
    const { id } = await t.jobs.enqueue(
      'state.work',
      { n: 1 },
      { idempotencyKey: 'by-key' },
    );

    expect(await t.jobs.cancelByKey('by-key')).toEqual({
      outcome: 'CANCELLED',
    });
    expect((await row(id)).status).toBe('CANCELLED');
    expect(await t.jobs.cancelByKey('by-key')).toEqual({
      outcome: 'CONFLICT',
      status: 'CANCELLED',
    });
    expect(await t.jobs.cancelByKey('no-such-key')).toEqual({
      outcome: 'NOT_FOUND',
    });
  });

  it("S49 AS-43: another shop's job cannot be cancelled and looks like it does not exist", async () => {
    const shopA = v4();
    const shopB = v4();
    const { id } = await t.jobs.enqueue(
      'state.work',
      { n: 1 },
      { shopId: shopA, idempotencyKey: 'a-key' },
    );

    expect(await t.jobs.cancel(id, { shopId: shopB })).toEqual({
      outcome: 'NOT_FOUND',
    });
    expect(await t.jobs.cancelByKey('a-key', { shopId: shopB })).toEqual({
      outcome: 'NOT_FOUND',
    });
    expect((await row(id)).status).toBe('QUEUED');

    expect(await t.jobs.cancel(id, { shopId: shopA })).toEqual({
      outcome: 'CANCELLED',
    });
  });

  it('S49 AS-44: an operator can retry a DEAD job; other statuses are a CONFLICT; the retry is audited', async () => {
    const lines: unknown[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((...args: unknown[]) => {
        lines.push(args[0]);
      });
    const dead = await insert('DEAD');
    const done = await insert('SUCCEEDED');
    try {
      expect(await admin.retryDead(dead, 'operator-7')).toEqual({
        outcome: 'RETRIED',
      });
    } finally {
      spy.mockRestore();
    }

    const job = await row(dead);
    expect(job).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      finishedAt: null,
      lockedBy: null,
    });
    expect(new Date(job.runAt).getTime()).toBe(t.clock.now().getTime());
    expect(lines).toContainEqual(
      expect.objectContaining({
        jobId: dead,
        previousStatus: 'DEAD',
        actorId: 'operator-7',
      }),
    );

    expect(await admin.retryDead(done, 'operator-7')).toEqual({
      outcome: 'CONFLICT',
      status: 'SUCCEEDED',
    });
    expect(await admin.retryDead(v4(), 'operator-7')).toEqual({
      outcome: 'NOT_FOUND',
    });
    expect(await t.worker.runOnce()).toBe(1);
  });

  it('S49 AS-45: two concurrent retries of one DEAD job: exactly one wins', async () => {
    const dead = await insert('DEAD');

    const results = await Promise.all([
      admin.retryDead(dead, 'a'),
      admin.retryDead(dead, 'b'),
    ]);

    expect(results.filter((r) => r.outcome === 'RETRIED')).toHaveLength(1);
    expect(results.find((r) => r.outcome !== 'RETRIED')).toEqual({
      outcome: 'CONFLICT',
      status: 'QUEUED',
    });
  });

  it('S49 AS-39: the admin cancel is the same operation as JobsService.cancel', async () => {
    const { id } = await t.jobs.enqueue('state.work', { n: 1 });
    expect(await admin.cancel(id)).toEqual({ outcome: 'CANCELLED' });
  });
});
