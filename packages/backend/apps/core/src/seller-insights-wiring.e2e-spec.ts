import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { leaderboardPageSchema } from '@marketplace-sandbox/contracts';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application (S40 L-004, L-015, L-018): `CoreModule` starts with the leaderboard and seller-stats modules
 * in it, the public top list answers anonymously, the shop-scoped routes demand a session, and the removed routes are gone.
 * A missing import or an unresolvable provider fails here, where a spec that builds its own small module cannot see it.
 */
describe('Seller insights wiring in the real core application', () => {
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

  it('S40 AS-17: the public top list is served anonymously by the started application', async () => {
    const res = await http()
      .get('/api/leaderboards?period=week')
      .set('X-Forwarded-For', '198.51.100.99')
      .expect(200);
    expect(leaderboardPageSchema.parse(res.body).source).toBe('live');
  });

  it('S40 AS-26: rank, today and stats demand a session; the old routes are gone', async () => {
    const shop = randomUUID();
    await http().get(`/api/shops/${shop}/rank`).expect(401);
    await http().get(`/api/shops/${shop}/dashboard/today`).expect(401);
    await http().get(`/api/shops/${shop}/stats`).expect(401);
    await http().get(`/api/leaderboards/shops/${shop}`).expect(404);
    await http().get('/api/sellers/me/stats').expect(404);
  });
});
