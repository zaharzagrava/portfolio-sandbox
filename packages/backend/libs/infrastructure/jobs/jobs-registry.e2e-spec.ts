import { Global, Injectable, Module } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { getConnectionToken } from '@nestjs/sequelize';
import { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { JobHandler } from './job-handler.decorator';
import { JobRegistry } from './job-registry.service';
import { declareJobType } from './job-type-registry';
import { JobsModule } from './jobs.module';
import { JobsService } from './jobs.service';
import { createJobsTestApp } from './testing/jobs-test-app';

declare module './job-types' {
  interface JobPayloads {
    'reg.dup': { n: number };
    'reg.fine': { n: number };
    'reg.enqueue-only': { n: number };
    'reg.undeclared': { n: number };
  }
}
declareJobType({ name: 'reg.dup', contract: z.object({ n: z.number() }) });
declareJobType({ name: 'reg.fine', contract: z.object({ n: z.number() }) });
declareJobType({
  name: 'reg.enqueue-only',
  contract: z.object({ n: z.number() }),
});

@Injectable()
class FirstProvider {
  @JobHandler('reg.dup')
  async run() {}
}

@Injectable()
class SecondProvider {
  @JobHandler('reg.dup')
  async run() {}
}

@Injectable()
class FineProvider {
  @JobHandler('reg.fine')
  async run() {}
}

@Module({ providers: [FineProvider] })
class FineModuleOne {}
@Module({ providers: [FineProvider] })
class FineModuleTwo {}

@Injectable()
class BadOptionProvider {
  @JobHandler('reg.fine', { leaseMs: 1 })
  async run() {}
}

@Injectable()
class BadNameProvider {
  @JobHandler('Bad Name' as never)
  async run() {}
}

@Injectable()
class UndeclaredProvider {
  @JobHandler('reg.undeclared')
  async run() {}
}

describe('Job handler and type registry (S49, e2e, real Postgres)', () => {
  it('S49 AS-91: two different providers for one job type fail startup, naming the type and both providers', async () => {
    await expect(
      createJobsTestApp({ providers: [FirstProvider, SecondProvider] }),
    ).rejects.toThrow(
      /duplicate @JobHandler for "reg\.dup".*(FirstProvider|SecondProvider)/,
    );
  });

  it('S49 AS-91: the same provider found twice (a module imported in two places) is fine', async () => {
    const t = await createJobsTestApp({
      modules: [FineModuleOne, FineModuleTwo],
    });
    try {
      expect(t.get<JobRegistry>(JobRegistry).get('reg.fine')?.provider).toBe(
        'FineProvider.run',
      );
    } finally {
      await t.close();
    }
  });

  it('S49 AS-92: a handler option out of range aborts startup with the type in the message', async () => {
    await expect(
      createJobsTestApp({ providers: [BadOptionProvider] }),
    ).rejects.toThrow(/"reg\.fine".*leaseMs/);
  });

  it('S49 AS-92: a malformed job type name aborts startup', async () => {
    await expect(
      createJobsTestApp({ providers: [BadNameProvider] }),
    ).rejects.toThrow(/Bad Name/);
  });

  it('S49 AS-92: a handler whose type was never declared aborts startup', async () => {
    await expect(
      createJobsTestApp({ providers: [UndeclaredProvider] }),
    ).rejects.toThrow(/reg\.undeclared.*declareJobType/);
  });

  it('S49 AS-94: an app without the worker module can still enqueue, because the declaration is separate from the handler', async () => {
    const clock = new FakeClock();
    @Global()
    @Module({
      providers: [{ provide: CLOCK, useValue: clock }],
      exports: [CLOCK],
    })
    class ClockOnly {}
    const moduleRef = await generateTestingModule([ClockOnly, JobsModule], {
      customize: (b) => b.overrideProvider(CLOCK).useValue(clock),
    });
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const sequelize = app.get(getConnectionToken());
      await sequelize.query(`TRUNCATE "Job", "JobKey", "JobSchedule"`);

      const result = await app
        .get(JobsService)
        .enqueue('reg.enqueue-only', { n: 1 }, { idempotencyKey: 'enq-only' });

      expect(result.created).toBe(true);
      const rows = await sequelize.query(
        `SELECT type, status FROM "Job" WHERE id = :id`,
        {
          type: QueryTypes.SELECT,
          replacements: { id: result.id },
        },
      );
      expect(rows).toEqual([{ type: 'reg.enqueue-only', status: 'QUEUED' }]);
    } finally {
      await app.close();
    }
  });

  it('S49 S54 follow-up: the worker with IdempotencyModule registers platform.purge-idempotency-keys and its 15-minute schedule', async () => {
    const clean = await createJobsTestApp(); // empties the job tables
    await clean.close();

    const t = await createJobsTestApp({
      modules: [IdempotencyModule],
      resetAfterBoot: false,
    });
    try {
      const handler = t
        .get<JobRegistry>(JobRegistry)
        .get('platform.purge-idempotency-keys');
      expect(handler).toMatchObject({
        type: 'platform.purge-idempotency-keys',
        concurrency: 1,
      });

      const rows = await t.sequelize.query<{
        cron: string;
        jobType: string;
        enabled: boolean;
      }>(
        `SELECT cron, "jobType", enabled FROM "JobSchedule" WHERE name = 'platform.purge-idempotency-keys'`,
        { type: QueryTypes.SELECT },
      );
      expect(rows).toEqual([
        {
          cron: '*/15 * * * *',
          jobType: 'platform.purge-idempotency-keys',
          enabled: true,
        },
      ]);
    } finally {
      await t.close();
    }
  });
});
