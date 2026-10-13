import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S25 L-004, L-015): `CoreModule` starts with the discussions
 * module in it, and its public reads are routed. A missing import or an unresolvable provider fails here, where the
 * capability specs (which build their own small module) cannot see it.
 */
describe('Discussions wiring in the real core application', () => {
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

  it('S25 AS-40: the started application serves an empty board, and refuses writes without credentials', async () => {
    const http = () => supertest(app.getHttpServer());
    const board = await http().get(`/api/boards/${uuidv4()}/posts`).expect(200);
    expect(board.body).toEqual({ items: [], nextCursor: null });
    await http()
      .post(`/api/boards/${uuidv4()}/posts`)
      .set('Idempotency-Key', uuidv4())
      .send({ title: 'No credentials' })
      .expect(401);
    await http().get(`/api/posts/${uuidv4()}`).expect(404);
  });
});
