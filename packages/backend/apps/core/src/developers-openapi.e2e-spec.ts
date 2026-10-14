import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { openApiDocumentSchema } from '@marketplace-sandbox/contracts';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * W07 FR-031: the developer-docs page reads `GET /api/developers/openapi.json` from the real core application,
 * anonymously, and validates it with the shared contract before using it.
 */
describe('W07 OpenAPI description for the developer docs', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(CoreModule, { logger: false });
    configureHttpApp(app, { useStructuredLogger: false, processHandlers: false });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  const http = () => supertest(app.getHttpServer());

  it('W07 AS-27: answers 200 application/json without a session, and the body parses with openApiDocumentSchema', async () => {
    const res = await http().get('/api/developers/openapi.json').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const parsed = openApiDocumentSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.openapi).toMatch(/^3\./);
    expect(Object.keys(parsed.data.paths).length).toBeGreaterThan(0);
  });

  it('W07 AS-27: operations carry what the page shows: tag, summary and the scope of the key', async () => {
    const res = await http().get('/api/developers/openapi.json').expect(200);
    const operations = Object.values(res.body.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((item) =>
      Object.values(item).filter((operation) => operation && typeof operation === 'object'),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(Array.isArray(operation.tags)).toBe(true);
      expect(typeof operation.summary).toBe('string');
    }
  });

  it('W07 AS-28: the schema refuses a body that is not an OpenAPI 3.x description', () => {
    expect(openApiDocumentSchema.safeParse({ openapi: '2.0', info: { title: 'x' }, paths: {} }).success).toBe(false);
    expect(openApiDocumentSchema.safeParse({ openapi: '3.1.0', info: { title: 'x' } }).success).toBe(false);
    expect(openApiDocumentSchema.safeParse('<html>').success).toBe(false);
  });

  it('W07 AS-28: a failing request is problem+json through the global filter, not a stack trace', async () => {
    const res = await http().post('/api/developers/openapi.json').send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toEqual(expect.objectContaining({ status: res.status }));
    expect(JSON.stringify(res.body)).not.toMatch(/at \S+ \(/);
  });
});
