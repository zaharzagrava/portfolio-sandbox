import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { DiscussionsWorkerModule } from '@app/domains/community';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S25 L-004, L-015, G7): `WorkerModule` starts with `DiscussionsWorkerModule` in it, so
 * the jobs, the event relay and their providers resolve in the process that owns them, and the schedules are
 * registered once.
 */
describe('Discussions wiring in the real worker application', () => {
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

  it('S25 AS-07: the started worker contains the discussions worker module, is live and has registered the discussions schedules', async () => {
    expect(app.get(DiscussionsWorkerModule, { strict: false })).toBeInstanceOf(
      DiscussionsWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string }>(
        `SELECT "name" FROM "JobSchedule" WHERE "name" LIKE 'discussions.%'`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules.map((s) => s.name).sort()).toEqual([
      'discussions.flush-votes',
      'discussions.reconcile',
      'discussions.relay-events',
      'discussions.relay-sweep',
    ]);
  });
});
