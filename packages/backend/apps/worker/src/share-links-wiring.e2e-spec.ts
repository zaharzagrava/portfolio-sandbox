import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { ShareLinksWorkerModule } from '@app/domains/marketing';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S37 L-004, L-015, G9): `WorkerModule` starts with `ShareLinksWorkerModule` in it, the job
 * type is declared with its payload contract, and the rebuild schedule is registered once.
 */
describe('Share links wiring in the real worker application', () => {
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

  it('S37 AS-33: the started worker contains the share-links worker module, declares the rebuild job and has registered its schedule', async () => {
    expect(app.get(ShareLinksWorkerModule, { strict: false })).toBeInstanceOf(
      ShareLinksWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const declaration = getJobTypeDeclaration('share-links.rebuild-filter');
    expect(declaration?.contract.safeParse({}).success).toBe(true);
    expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'share-links.%'`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual([
      'share-links.rebuild-filter',
    ]);
  });
});
