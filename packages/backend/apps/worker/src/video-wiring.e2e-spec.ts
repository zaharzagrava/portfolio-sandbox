import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { VideoWorkerModule } from '@app/domains/media';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S30 L-004, L-015, S49 follow-up): `WorkerModule` starts with `VideoWorkerModule` in it,
 * the three job types are declared with their payload contracts, and the three schedules are registered once.
 */
describe('Video wiring in the real worker application', () => {
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

  it('S30 AS-50: the started worker declares the expire, re-drive and purge jobs and has scheduled them', async () => {
    expect(app.get(VideoWorkerModule, { strict: false })).toBeInstanceOf(
      VideoWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    for (const name of [
      'media.video-expire-uploads',
      'media.video-requeue-stuck',
      'media.video-purge',
    ]) {
      const declaration = getJobTypeDeclaration(name as never);
      expect(declaration?.contract.safeParse({}).success).toBe(true);
      expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    }
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'media.video-%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual([
      'media.video-expire-uploads',
      'media.video-purge',
      'media.video-requeue-stuck',
    ]);
  });
});
