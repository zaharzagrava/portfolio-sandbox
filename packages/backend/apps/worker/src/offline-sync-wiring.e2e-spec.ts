import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S09 L-004, L-015, L-018): `WorkerModule` starts with `OfflineSyncWorkerModule` in it, so
 * the jobs resolve every provider they inject, and the recovery, compaction and purge schedules are registered.
 */
describe('Offline sync wiring in the real worker application', () => {
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

  it('S09 AS-14: the worker application starts, answers its liveness probe and has registered the three schedules', async () => {
    expect(
      (await supertest(app.getHttpServer()).get('/health/live')).status,
    ).toBe(200);
    const db = app.get<Sequelize>(getConnectionToken(), { strict: false });
    const found = await db.query<{ name: string }>(
      `SELECT "name" FROM "JobSchedule" WHERE "name" IN
         ('catalog-sync.redrive-stale-ops', 'catalog-sync.compact-change-log', 'catalog-sync.purge-sync-operations')`,
      { type: QueryTypes.SELECT },
    );
    expect(found.map((r) => r.name).sort()).toEqual([
      'catalog-sync.compact-change-log',
      'catalog-sync.purge-sync-operations',
      'catalog-sync.redrive-stale-ops',
    ]);
  });
});
