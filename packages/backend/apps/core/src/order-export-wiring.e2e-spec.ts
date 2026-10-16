import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application (S12 L-004, L-015, L-018): `CoreModule` starts with `OrderExportModule` in it, the five
 * export routes are routed behind credentials, and the routes of the old catalog-sync controller are gone.
 */
describe('Order export wiring in the real core application', () => {
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

  it('S12 T082: the application starts and routes the export routes behind credentials; the old paths are 404', async () => {
    const http = () => supertest(app.getHttpServer());
    expect((await http().get('/health/live')).status).toBe(200);
    const shop = '00000000-0000-4000-8000-000000000001';
    const exportId = '00000000-0000-4000-8000-000000000002';
    for (const res of [
      await http().post(`/api/shops/${shop}/order-exports`).send({}),
      await http().get(`/api/shops/${shop}/order-exports`),
      await http().get(`/api/shops/${shop}/order-exports/${exportId}`),
      await http()
        .post(`/api/shops/${shop}/order-exports/${exportId}/cancel`)
        .send(),
      await http().get(`/api/shops/${shop}/order-exports/${exportId}/download`),
    ])
      expect(res.status).toBe(401);
    for (const res of [
      await http().post(`/api/shops/${shop}/exports/orders`).send({}),
      await http().get(`/api/shops/${shop}/exports/${exportId}`),
    ])
      expect(res.status).toBe(404);
  });
});
