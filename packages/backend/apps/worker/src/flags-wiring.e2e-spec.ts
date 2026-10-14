import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { FlagsClient, FlagsWorkerModule } from '@app/domains/experimentation';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S38 L-004, L-015, R-8): `WorkerModule` starts with `FlagsWorkerModule` in it, the repair job
 * type is declared with its payload contract, and its schedule is registered once. The SDK it embeds is ready.
 */
describe('Flags wiring in the real worker application', () => {
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

  it('S38 AS-26: the started worker contains the flags worker module, declares the repair job and has registered its schedule', async () => {
    expect(app.get(FlagsWorkerModule, { strict: false })).toBeInstanceOf(
      FlagsWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const declaration = getJobTypeDeclaration('flags.repair-ruleset');
    expect(declaration?.contract.safeParse({}).success).toBe(true);
    expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string; cron: string }>(
        `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'flags.%'`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules).toEqual([
      { name: 'flags.repair-ruleset', cron: '*/30 * * * * *' },
    ]);
    expect(app.get(FlagsClient).ready).toBe(true);
  });
});
