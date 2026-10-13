import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S19 L-015, L-004): `CoreModule` starts, and the shopper reads of
 * the pickup capability are routed in it. A missing import or a provider nobody can resolve fails here, where a spec
 * that builds its own small module cannot see it.
 */
describe('Pickup wiring in the real core application', () => {
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

  it('S19 AS-07: the three public pickup reads are served by the started application', async () => {
    const http = () => supertest(app.getHttpServer());
    await http()
      .get('/api/search/near')
      .query({ lat: '52.52', lng: '13.4' })
      .expect(200);
    await http()
      .get('/api/pickup-points/near')
      .query({ lat: '52.52', lng: '13.4' })
      .expect(200);
    await http()
      .get('/api/pickup-points/clusters')
      .query({ bbox: '53,13,52,14' })
      .expect(200);
  });
});
