import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { MediaWorkerModule } from '@app/domains/media';
import { JobsService } from '@app/infrastructure/jobs';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S29 L-004, L-015, FR-092): `WorkerModule` starts with `MediaWorkerModule` in it, the three
 * job types are declared with their payload contracts, and the three schedules are registered once.
 */
describe('Media wiring in the real worker application', () => {
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

  it('S29 AS-51: the started worker declares the expire, re-drive and purge jobs and has scheduled them', async () => {
    expect(app.get(MediaWorkerModule, { strict: false })).toBeInstanceOf(
      MediaWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    for (const name of [
      'media.expire-pending-uploads',
      'media.requeue-stuck',
      'media.purge',
    ]) {
      const declaration = getJobTypeDeclaration(name as never);
      expect(declaration?.contract.safeParse({}).success).toBe(true);
      expect(declaration?.contract.safeParse({ extra: 1 }).success).toBe(false);
    }
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'media.%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name)).toEqual([
      'media.expire-pending-uploads',
      'media.purge',
      'media.requeue-stuck',
    ]);
  });

  it('S29 AS-51: a job enqueued for the expiry type is run by the real job registry and expires a stale upload slot', async () => {
    const sequelize = app.get(Sequelize);
    const user = randomUUID();
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO "Media" ("uploaderId","purpose","originalKey","createdAt","updatedAt")
       VALUES (:user, 'review', :key, now() - interval '3 hours', now() - interval '3 hours') RETURNING "id"`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          user,
          key: `media/originals/users/${user}/${randomUUID()}`,
        },
      },
    );
    const { id: jobId } = await app
      .get(JobsService)
      .enqueue('media.expire-pending-uploads', {});
    let status = 'QUEUED';
    for (
      let i = 0;
      i < 60 && status !== 'SUCCEEDED' && status !== 'DEAD';
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = (
        await sequelize.query<{ status: string }>(
          `SELECT "status" FROM "Job" WHERE "id" = :jobId`,
          {
            type: QueryTypes.SELECT,
            replacements: { jobId },
          },
        )
      )[0].status;
    }
    expect(status).toBe('SUCCEEDED');
    const [after] = await sequelize.query<{ status: string }>(
      `SELECT "status" FROM "Media" WHERE "id" = :id`,
      {
        type: QueryTypes.SELECT,
        replacements: { id: row.id },
      },
    );
    expect(after.status).toBe('EXPIRED');
    await sequelize.query(
      `DELETE FROM "MediaStatusHistory" WHERE "mediaId" = :id`,
      { replacements: { id: row.id } },
    );
    await sequelize.query(`DELETE FROM "Media" WHERE "id" = :id`, {
      replacements: { id: row.id },
    });
  });
});
