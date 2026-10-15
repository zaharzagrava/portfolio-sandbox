import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S17 L-004, L-015, L-018): `WorkerModule` starts with `BillingWorkerModule` in it, so
 * the four billing job handlers resolve every provider they inject and the renewal run is scheduled exactly once.
 */
describe('Billing wiring in the real worker application', () => {
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

  it('S17 AS-29: the worker starts, handles the four billing jobs and has registered the renewal schedule once', async () => {
    expect(
      (await supertest(app.getHttpServer()).get('/health/live')).status,
    ).toBe(200);
    const registry = app.get(JobRegistry, { strict: false });
    for (const type of [
      'billing.run',
      'billing.charge-invoice',
      'billing.resolve-attempt',
      'billing.manual-attempt',
    ])
      expect(registry.get(type)).toBeDefined();
    expect(registry.get('billing.run')?.leaseMs).toBe(600_000);
    const db = app.get<Sequelize>(getConnectionToken(), { strict: false });
    const found = await db.query<{ cron: string; timezone: string }>(
      `SELECT "cron", "timezone" FROM "JobSchedule" WHERE "name" = 'billing.run'`,
      { type: QueryTypes.SELECT },
    );
    expect(found).toEqual([{ cron: '*/10 * * * *', timezone: 'UTC' }]);
  });
});
