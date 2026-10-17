import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { LeaderboardsWorkerModule } from '@app/domains/seller-insights';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S40 L-004, L-015, L-018): `WorkerModule` starts with `LeaderboardsWorkerModule` in it, so
 * the dashboard ticker, the snapshot job and their providers resolve in the process that owns them, and the two
 * snapshot schedules are registered once.
 */
describe('Seller insights wiring in the real worker application', () => {
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

  it('S40 AS-35: the started worker contains the leaderboards worker module, is live and has registered the two snapshot schedules', async () => {
    expect(app.get(LeaderboardsWorkerModule, { strict: false })).toBeInstanceOf(
      LeaderboardsWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string; cron: string }>(
        `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'seller-insights.%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules).toEqual([
      { name: 'seller-insights.snapshot.monthly', cron: '0 1 1 * *' },
      { name: 'seller-insights.snapshot.weekly', cron: '0 1 * * 1' },
    ]);
  });
});
