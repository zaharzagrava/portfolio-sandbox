import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { AnalyticsWorkerModule } from '@app/domains/experimentation';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S39 L-004, L-015): `WorkerModule` starts with `AnalyticsWorkerModule` in it, the dead-letter
 * watcher job type is declared with its payload contract, and its schedule is registered once.
 */
describe('Analytics wiring in the real worker application', () => {
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

  it('S39 AS-14: the started worker contains the analytics worker module, declares the watcher job and has registered its schedule', async () => {
    expect(app.get(AnalyticsWorkerModule, { strict: false })).toBeInstanceOf(
      AnalyticsWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const declaration = getJobTypeDeclaration('analytics.watch-dead-letters');
    expect(declaration?.contract.safeParse({}).success).toBe(true);
    expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string; cron: string }>(
        `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'analytics.%'`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules).toEqual([
      { name: 'analytics.watch-dead-letters', cron: '*/30 * * * * *' },
    ]);
  });
});
