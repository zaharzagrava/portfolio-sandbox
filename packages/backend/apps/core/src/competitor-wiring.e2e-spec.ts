import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application (S41 L-004, L-015, L-018): `CoreModule` starts with the competitor module in it and the
 * four competitor routes demand a session. A missing import or an unresolvable provider fails here, where a spec that
 * builds its own small module cannot see it.
 */
describe('Competitor monitor wiring in the real core application', () => {
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

  it('S41 AS-07: the four competitor routes are served by the started application and demand a session', async () => {
    const http = supertest(app.getHttpServer());
    const shop = randomUUID();
    const watch = randomUUID();
    await http.post(`/api/shops/${shop}/competitors`).send({}).expect(401);
    await http.get(`/api/shops/${shop}/competitors`).expect(401);
    await http.delete(`/api/shops/${shop}/competitors/${watch}`).expect(401);
    await http
      .get(`/api/shops/${shop}/competitors/${watch}/prices`)
      .expect(401);
  });
});
