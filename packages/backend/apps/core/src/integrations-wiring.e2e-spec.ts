import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S08 L-015, L-018): `CoreModule` starts with `IntegrationsModule`
 * in it, and the connect routes are routed. A missing import or a provider nobody can resolve fails here.
 */
describe('Integrations wiring in the real core application', () => {
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

  it('S08 AS-03: the anonymous OAuth callback is routed and refuses an unsigned request with invalid_oauth_callback', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/integrations/shopify/callback')
      .redirects(0);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_oauth_callback');
  });

  it('S08 AS-02: the install and Woo connect routes are routed and need credentials', async () => {
    const shopId = '00000000-0000-4000-8000-000000000001';
    const http = () => supertest(app.getHttpServer());
    expect(
      (
        await http()
          .post(`/api/shops/${shopId}/integrations/shopify/install`)
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (await http().post(`/api/shops/${shopId}/integrations`).send({})).status,
    ).toBe(401);
  });
});
