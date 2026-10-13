import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { MediaQueryService } from '@app/domains/media';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S29 L-015, L-004): `CoreModule` starts with `MediaModule` in it,
 * the photo routes are mounted, the R1 service resolves, and the old `discussion.write` borrowing is gone. A missing
 * import, a provider nobody can resolve or a duplicate event definition fails here, where a spec that builds its own
 * small module cannot see it.
 */
describe('Media wiring in the real core application', () => {
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

  it('S29 AS-41: the public photo reads are served by the started application', async () => {
    const unknown = await http().get(`/api/media/${randomUUID()}`).expect(404);
    expect(unknown.body.code).toBe('media_not_found');
    expect(
      (await http().get(`/api/batch/media?ids=${randomUUID()}`).expect(200))
        .body,
    ).toEqual([null]);
    expect(
      (await http().get(`/api/products/${randomUUID()}/gallery`).expect(404))
        .body.code,
    ).toBe('product_not_found');
  });

  it('S29 AS-01: the upload routes demand a session', async () => {
    await http()
      .post('/api/media/uploads')
      .send({ purpose: 'review' })
      .expect(401);
    await http()
      .post(`/api/shops/${randomUUID()}/media/uploads`)
      .send({ purpose: 'product' })
      .expect(401);
    await http()
      .put(`/api/shops/${randomUUID()}/products/${randomUUID()}/gallery`)
      .send({})
      .expect(401);
  });

  it('S29 AS-45: the R1 lookup is exported and answers from the started application', async () => {
    const found = await app
      .get(MediaQueryService)
      .getReadyMediaByIds([randomUUID()]);
    expect(found.size).toBe(0);
  });
});
