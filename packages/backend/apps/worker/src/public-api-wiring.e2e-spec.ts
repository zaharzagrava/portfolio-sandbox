import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { PublicApiWorkerModule } from '@app/domains/developer-platform';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { WorkerModule } from './worker.module';

const JOBS = [
  'public-api.close-usage-minutes',
  'public-api.flush-key-usage',
  'public-api.purge-bulk-jobs',
];
const QUEUE = 'public-api-bulk-chunk';

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${ms} ms`);
};

/**
 * The real worker application (S42 L-004, L-015, L-018): `WorkerModule` starts with `PublicApiWorkerModule` in it, the
 * three job types are declared with payload contracts and scheduled, the bulk chunk consumer is part of the module that
 * starts, and the pod is not ready while the queue it consumes is missing.
 */
describe('Public API wiring in the real worker application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(WorkerModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S42 AS-58: the started worker declares the three public API jobs with strict contracts and has scheduled them', async () => {
    expect(app.get(PublicApiWorkerModule, { strict: false })).toBeInstanceOf(
      PublicApiWorkerModule,
    );
    for (const name of JOBS) {
      const declaration = getJobTypeDeclaration(name as never);
      expect(declaration?.contract.safeParse({}).success).toBe(true);
      expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    }
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'public-api.%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual(JOBS);
  });

  it('S42 AS-51: the bulk chunk consumer is a provider of the module the worker starts', () => {
    const providers = Reflect.getMetadata(
      'providers',
      PublicApiWorkerModule,
    ) as Array<{ name?: string }>;
    expect(providers.map((p) => p.name)).toContain('PublicApiWorkers');
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    expect(imports).toContain(PublicApiWorkerModule);
  });

  it('S42 AS-51: the worker is ready while the bulk chunk queue exists and not ready while it is missing (L-002)', async () => {
    const readiness = app.get(ReadinessService);
    const check = `queue:${QUEUE}`;
    await until(async () => (await readiness.report()).checks[check] === 'up');
    const queue = app.get(TaskQueue);
    const exists = jest
      .spyOn(queue, 'queueExists')
      .mockImplementation((name) => Promise.resolve(name !== QUEUE));
    try {
      await until(async () => {
        const report = await readiness.report();
        return report.checks[check] === 'down' && !report.ready;
      });
    } finally {
      exists.mockRestore();
    }
    await until(async () => (await readiness.report()).checks[check] === 'up');
  });
});
