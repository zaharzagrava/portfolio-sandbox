import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application, not a module a spec assembled (S24 L-004, L-015, L-018): `CoreModule` starts and the chat
 * routes of the domain are mapped in it. A missing import, a provider nobody can resolve or a route that did not get
 * registered fails here, where a spec that builds its own small module cannot see it.
 */
describe('Chat wiring in the real core application', () => {
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

  const id = '0192f3a0-0000-7000-8000-000000000001';

  it('S24 AS-58: every chat route is mapped in the started application (a mapped route answers 401 problem+json, an unmapped one 404)', async () => {
    const http = () => supertest(app.getHttpServer());
    const calls: Array<[string, string]> = [
      ['post', '/api/chat/channels'],
      ['get', `/api/chat/channels/${id}`],
      ['get', `/api/chat/channels/by-product/${id}`],
      ['patch', `/api/chat/channels/${id}`],
      ['post', `/api/chat/channels/${id}/join`],
      ['get', `/api/chat/channels/${id}/messages`],
      ['post', `/api/chat/channels/${id}/messages`],
      ['delete', `/api/chat/channels/${id}/messages/${id}`],
      ['post', `/api/chat/channels/${id}/read`],
      ['post', `/api/chat/channels/${id}/members/ban`],
      ['post', `/api/chat/channels/${id}/members/mute`],
      ['post', '/api/chat/sync'],
      ['get', '/api/chat/unread'],
      ['get', '/api/chat/presence'],
      ['post', '/api/chat/presence/heartbeat'],
      ['post', '/api/chat/ws-ticket'],
    ];
    for (const [method, path] of calls) {
      const res = await (
        http() as unknown as Record<string, (p: string) => supertest.Test>
      )[method](path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(res.body.code).toEqual(expect.any(String));
      expect(res.body.code).not.toBe('not_found');
    }
  });
});
