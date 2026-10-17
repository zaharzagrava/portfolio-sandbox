import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { CrawlerWorkerModule } from '@app/domains/seller-insights';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S41 L-004, L-015, L-018): `WorkerModule` starts with `CrawlerWorkerModule` in it, so the
 * scheduler, the fetch loops and the purge job resolve in the process that owns them, and their two schedules are
 * registered once.
 */
describe('Competitor monitor wiring in the real worker application', () => {
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

  it('S41 AS-16: the started worker contains the crawler module, is live and has registered the scheduler and the purge', async () => {
    expect(app.get(CrawlerWorkerModule, { strict: false })).toBeInstanceOf(
      CrawlerWorkerModule,
    );
    await supertest(app.getHttpServer()).get('/health/live').expect(200);
    const schedules = await app
      .get(Sequelize)
      .query<{ name: string; cron: string }>(
        `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'crawler.%' ORDER BY "name"`,
        { type: QueryTypes.SELECT },
      );
    expect(schedules).toEqual([
      { name: 'crawler.purge-targets', cron: '30 3 * * *' },
      { name: 'crawler.schedule-due', cron: '* * * * *' },
    ]);
  });
});
