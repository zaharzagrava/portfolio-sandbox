import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S30 L-015, L-004): `CoreModule` starts with `VideoModule` in it,
 * the video routes are mounted, anonymous playback answers, the seller routes demand a session. A missing import, a
 * provider nobody can resolve or a duplicate event definition fails here, where a spec that builds its own small module
 * cannot see it.
 */
describe('Video wiring in the real core application', () => {
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

  const http = () => supertest(app.getHttpServer());

  it('S30 AS-31: the public routes are served by the started application', async () => {
    const unknown = await http()
      .get(`/api/videos/${randomUUID()}/playback`)
      .expect(404);
    expect(unknown.body.code).toBe('video_not_found');
    const product = await http()
      .get(`/api/products/${randomUUID()}/videos`)
      .expect(404);
    expect(product.body.code).toBe('product_not_found');
  });

  it('S30 AS-03: every seller route demands a session', async () => {
    const shop = randomUUID();
    const id = randomUUID();
    await http().post(`/api/shops/${shop}/videos`).send({}).expect(401);
    await http().get(`/api/shops/${shop}/videos`).expect(401);
    await http().get(`/api/shops/${shop}/videos/${id}`).expect(401);
    await http().get(`/api/shops/${shop}/videos/${id}/upload`).expect(401);
    await http()
      .post(`/api/shops/${shop}/videos/${id}/complete`)
      .send({})
      .expect(401);
    await http().patch(`/api/shops/${shop}/videos/${id}`).send({}).expect(401);
    await http().post(`/api/shops/${shop}/videos/${id}/retry`).expect(401);
    await http().delete(`/api/shops/${shop}/videos/${id}`).expect(401);
  });
});
