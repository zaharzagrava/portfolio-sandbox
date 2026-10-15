import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { planCatalogSchema } from '@marketplace-sandbox/contracts';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application (S17 L-004, L-015, L-018): `CoreModule` starts with `BillingModule` in it, and the plan
 * catalog, the subscription routes of shops and buyers and the operator's catalog routes are routed. A provider the
 * module forgot to import, or a controller nobody can construct, stops the application here and nowhere else.
 */
describe('Billing wiring in the real core application', () => {
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

  it('S17 AS-82: the application starts, serves the public catalog and routes the billing routes behind credentials', async () => {
    const http = () => supertest(app.getHttpServer());
    expect((await http().get('/health/live')).status).toBe(200);
    const plans = await http().get('/api/plans');
    expect(plans.status).toBe(200);
    expect(planCatalogSchema.parse(plans.body).plans.length).toBeGreaterThan(0);
    const shop = '00000000-0000-4000-8000-000000000001';
    for (const res of [
      await http().get(`/api/shops/${shop}/subscription`),
      await http().post(`/api/shops/${shop}/subscription`).send({}),
      await http()
        .put(`/api/shops/${shop}/subscription/payment-method`)
        .send({}),
      await http().get(`/api/shops/${shop}/invoices`),
      await http().get('/api/me/subscription'),
      await http().get('/api/me/invoices'),
      await http().post('/api/admin/billing/plans').send({}),
    ])
      expect(res.status).toBe(401);
  });

  it('S18 T052: the application starts with the entitlement guard validator over every controller and routes the usage reads behind credentials', async () => {
    const http = () => supertest(app.getHttpServer());
    expect((await http().get('/health/live')).status).toBe(200);
    const shop = '00000000-0000-4000-8000-000000000001';
    expect((await http().get(`/api/shops/${shop}/usage`)).status).toBe(401);
    expect((await http().get('/api/me/usage')).status).toBe(401);
  });
});
