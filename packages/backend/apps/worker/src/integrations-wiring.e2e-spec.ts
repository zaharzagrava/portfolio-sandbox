import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { WorkerModule } from './worker.module';

/**
 * The real worker application (S08 L-004, L-015, L-018): `WorkerModule` starts with `IntegrationsWorkerModule` in it, so
 * the queue consumers of `integration-sync` and `integration-backfill` resolve every provider they inject. The consumers
 * and jobs of later stories join this module and are proven by their own specs.
 */
describe('Integrations wiring in the real worker application', () => {
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

  it('S08 AS-21: the worker application starts and answers its liveness probe', async () => {
    const res = await supertest(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });
});
