import { Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { v4 } from 'uuid';
import { z } from 'zod';
import { inParallel } from '@app/test/utils/async-helpers';
import { RequestContext } from '@app/infrastructure/context';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { JobHandler } from './job-handler.decorator';
import { declareJobType } from './job-type-registry';
import {
  IdempotencyKeyConflictError,
  InvalidJobPayloadError,
  UnknownJobTypeError,
} from './job-errors';
import { createJobsTestApp, JobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'enq.basic': { n: number };
    'enq.other': { n: number };
  }
}

declareJobType({ name: 'enq.basic', contract: z.object({ n: z.number() }) });
declareJobType({ name: 'enq.other', contract: z.object({ n: z.number() }) });

@Injectable()
class EnqHandlers {
  readonly executed: number[] = [];

  @JobHandler('enq.basic')
  async basic({ n }: { n: number }) {
    this.executed.push(n);
  }

  @JobHandler('enq.other')
  async other() {}
}

describe('Job enqueue (S49, e2e, real Postgres)', () => {
  let t: JobsTestApp;
  let handlers: EnqHandlers;

  const rows = (sql: string, replacements: Record<string, unknown> = {}) =>
    t.sequelize.query<Record<string, unknown>>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  const count = async (table: string) =>
    Number(
      (await rows(`SELECT count(*)::int AS n FROM "${table}"`))[0].n as number,
    );

  beforeAll(async () => {
    t = await createJobsTestApp({ providers: [EnqHandlers] });
    handlers = t.get(EnqHandlers);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.reset();
    handlers.executed.length = 0;
  });

  it('S49 AS-01: a delayed job is not claimed before runAt and runs after it', async () => {
    const runAt = new Date(t.clock.now().getTime() + 3_600_000);
    const { id, created } = await t.jobs.enqueue(
      'enq.basic',
      { n: 1 },
      { runAt },
    );
    expect(created).toBe(true);

    expect(await t.worker.runOnce()).toBe(0);
    expect(handlers.executed).toEqual([]);
    expect(
      (await rows(`SELECT status FROM "Job" WHERE id = :id`, { id }))[0].status,
    ).toBe('QUEUED');

    t.clock.advance(3_600_000);
    expect(await t.worker.runOnce()).toBe(1);
    expect(handlers.executed).toEqual([1]);
    expect(
      (await rows(`SELECT status FROM "Job" WHERE id = :id`, { id }))[0].status,
    ).toBe('SUCCEEDED');
  });

  it('S49 AS-02: enqueue joins the caller transaction; a rollback leaves no job and no key', async () => {
    const runner = t.get<TransactionRunner>(TransactionRunner);
    await expect(
      runner.run(async () => {
        const r = await t.jobs.enqueue(
          'enq.basic',
          { n: 2 },
          { idempotencyKey: 'rollback-key' },
        );
        expect(r.created).toBe(true);
        throw new Error('domain change failed');
      }),
    ).rejects.toThrow('domain change failed');

    expect(await count('Job')).toBe(0);
    expect(await count('JobKey')).toBe(0);

    const committed = await runner.run(() =>
      t.jobs.enqueue('enq.basic', { n: 3 }, { idempotencyKey: 'commit-key' }),
    );
    expect(committed.created).toBe(true);
    expect(await count('Job')).toBe(1);
    expect(await count('JobKey')).toBe(1);
  });

  it('S49 AS-03: the same key returns the original job with created: false', async () => {
    const first = await t.jobs.enqueue(
      'enq.basic',
      { n: 1 },
      { idempotencyKey: 'k-1' },
    );
    const second = await t.jobs.enqueue(
      'enq.basic',
      { n: 99 },
      { idempotencyKey: 'k-1' },
    );

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await count('Job')).toBe(1);
    expect((await rows(`SELECT payload FROM "Job"`))[0].payload).toEqual({
      n: 1,
    });
  });

  it('S49 AS-04: 20 concurrent enqueues of one key create one job and exactly one sees created: true', async () => {
    const key = `order-${v4()}`;
    const results = await inParallel(20, () =>
      t.jobs.enqueue('enq.basic', { n: 1 }, { idempotencyKey: key }),
    );

    const ok = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    expect(ok).toHaveLength(20);
    expect(new Set(ok.map((r) => r.id)).size).toBe(1);
    expect(ok.filter((r) => r.created)).toHaveLength(1);
    expect(await count('Job')).toBe(1);
  });

  it('S49 AS-05: a key reused with another job type fails with IdempotencyKeyConflictError', async () => {
    await t.jobs.enqueue('enq.basic', { n: 1 }, { idempotencyKey: 'shared' });

    await expect(
      t.jobs.enqueue('enq.other', { n: 1 }, { idempotencyKey: 'shared' }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: IdempotencyKeyConflictError.name,
        key: 'shared',
        existingType: 'enq.basic',
      }),
    );
    expect(await count('Job')).toBe(1);
  });

  it('S49 AS-05: a legacy key without a stored type is checked against the job row', async () => {
    await t.jobs.enqueue('enq.basic', { n: 1 }, { idempotencyKey: 'legacy' });
    await t.sequelize.query(`UPDATE "JobKey" SET type = NULL`);

    await expect(
      t.jobs.enqueue('enq.other', { n: 1 }, { idempotencyKey: 'legacy' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    const same = await t.jobs.enqueue(
      'enq.basic',
      { n: 1 },
      { idempotencyKey: 'legacy' },
    );
    expect(same.created).toBe(false);
  });

  it('S49 AS-06: an unknown type or an invalid payload is rejected and nothing is persisted', async () => {
    await expect(
      t.jobs.enqueue('nobody.declared-this' as never, {} as never, {
        idempotencyKey: 'x',
      }),
    ).rejects.toBeInstanceOf(UnknownJobTypeError);

    const bad = t.jobs.enqueue('enq.basic', { n: 'secret-value' } as never, {
      idempotencyKey: 'y',
    });
    await expect(bad).rejects.toBeInstanceOf(InvalidJobPayloadError);
    await expect(bad).rejects.toEqual(
      expect.objectContaining({ fields: ['n'] }),
    );
    await expect(bad).rejects.not.toThrow(/secret-value/);

    expect(await count('Job')).toBe(0);
    expect(await count('JobKey')).toBe(0);
  });

  it('S49 AS-07: an out-of-range option is rejected with the field name and nothing is persisted', async () => {
    await expect(
      t.jobs.enqueue('enq.basic', { n: 1 }, { maxAttempts: 26 }),
    ).rejects.toEqual(expect.objectContaining({ field: 'maxAttempts' }));
    expect(await count('Job')).toBe(0);
  });

  it('S49 AS-08: with no caller transaction the job commits on its own', async () => {
    const { id } = await t.jobs.enqueue(
      'enq.basic',
      { n: 8 },
      { idempotencyKey: 'solo' },
    );

    // a different connection sees it at once
    const [seen] = await rows(`SELECT id FROM "Job" WHERE id = :id`, { id });
    expect(seen.id).toBe(id);
    expect(await count('JobKey')).toBe(1);
  });

  it('S49 G-05: if the key row cannot be found after a lost race, the insert is retried once instead of crashing', async () => {
    const real = t.sequelize.query.bind(t.sequelize) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    let first = true;
    const spy = jest
      .spyOn(t.sequelize, 'query')
      // the first (insert) statement reports "nothing created, nothing found", as after a lost race with a purge
      .mockImplementation(((...args: unknown[]) => {
        if (first) {
          first = false;
          return Promise.resolve([]);
        }
        return real(...args);
      }) as never);
    try {
      const result = await t.jobs.enqueue(
        'enq.basic',
        { n: 5 },
        { idempotencyKey: 'vanished' },
      );
      expect(result.created).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await count('Job')).toBe(1);
  });

  it('S49 G-07: the originating request id and trace are stored with the job', async () => {
    const context = t.get<RequestContext>(RequestContext);
    const traceparent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const { id } = await context.run(
      { requestId: 'req-abc', traceparent },
      () => t.jobs.enqueue('enq.basic', { n: 7 }),
    );

    const [row] = await rows(
      `SELECT "enqueuedByRequestId", traceparent FROM "Job" WHERE id = :id`,
      { id },
    );
    expect(row).toEqual({ enqueuedByRequestId: 'req-abc', traceparent });
  });
});
