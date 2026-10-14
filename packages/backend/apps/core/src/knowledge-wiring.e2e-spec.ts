import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { KnowledgeModule } from '@app/domains/assistant';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real application, not a module a spec assembled (S47 L-004, L-015): `CoreModule` starts with the knowledge module in
 * it, every provider of its graph resolves, and its routes are served. A missing import or an unresolvable provider fails
 * here, where the capability specs (which build their own small module) cannot see it.
 */
describe('Knowledge wiring in the real core application', () => {
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

  it('S47 AS-55: the started core contains the knowledge module and serves its routes', async () => {
    expect(app.get(KnowledgeModule, { strict: false })).toBeInstanceOf(
      KnowledgeModule,
    );
    const http = () => supertest(app.getHttpServer());
    const shop = uuidv4();
    const document = uuidv4();

    // the one anonymous route reaches the service: an unknown product is the same 404 as everywhere
    const asked = await http()
      .post(`/api/products/${uuidv4()}/ask`)
      .send({ question: 'does it support eSIM?' });
    expect(asked.status).toBe(404);
    expect(asked.body.code).toBe('not_found');
    // an invalid body is refused before any lookup
    await http()
      .post(`/api/products/${uuidv4()}/ask`)
      .send({ question: 'ab' })
      .expect(400);
    // every other route is guarded
    for (const [method, url] of [
      ['post', `/api/shops/${shop}/knowledge/documents`],
      ['get', `/api/shops/${shop}/knowledge/documents`],
      ['get', `/api/shops/${shop}/knowledge/documents/${document}`],
      ['delete', `/api/shops/${shop}/knowledge/documents/${document}`],
      ['post', `/api/shops/${shop}/knowledge/documents/${document}/uploaded`],
      ['post', `/api/shops/${shop}/knowledge/documents/${document}/retry`],
      ['post', `/api/shops/${shop}/knowledge/ask`],
      ['post', '/api/admin/knowledge/documents'],
      ['get', '/api/admin/knowledge/documents'],
      ['post', '/api/admin/knowledge/reindex'],
    ] as const)
      expect([method, url, (await http()[method](url)).status]).toEqual([
        method,
        url,
        401,
      ]);
  });
});
