import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S09 L-015, L-018): `CoreModule` starts with `OfflineSyncModule`
 * in it and the four sync routes are routed. A missing import or a provider nobody can resolve fails here.
 */
describe('Offline sync wiring in the real core application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(CoreModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S09 AS-42: the application answers its liveness probe and the four sync routes are routed and need credentials', async () => {
    const http = () => supertest(app.getHttpServer());
    expect((await http().get('/health/live')).status).toBe(200);
    const shop = '00000000-0000-4000-8000-000000000001';
    const op = '00000000-0000-7000-8000-000000000002';
    for (const res of [
      await http().post(`/api/shops/${shop}/sync/push`).send({ ops: [] }),
      await http().get(`/api/shops/${shop}/sync/pull`),
      await http().get(`/api/shops/${shop}/sync/conflicts`),
      await http().post(`/api/shops/${shop}/sync/conflicts/${op}/dismiss`),
    ])
      expect(res.status).toBe(401);
  });
});
