import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application, not a module a spec assembled (S42 L-004, L-015, L-018): `CoreModule` starts and the
 * dashboard routes of the developer platform are mapped in it, with the same-origin OpenAPI description (W07).
 */
describe('Developer platform wiring in the real core application', () => {
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

  it('S42 AS-04: every dashboard route of keys, version, logs and usage is mapped in the started application (a mapped route answers 401 problem+json, an unmapped one 404)', async () => {
    const http = () => supertest(app.getHttpServer());
    const base = `/api/shops/${id}/developers`;
    const calls: Array<[string, string]> = [
      ['post', `${base}/keys`],
      ['get', `${base}/keys`],
      ['post', `${base}/keys/${id}/rotate`],
      ['delete', `${base}/keys/${id}`],
      ['get', `${base}/api-version`],
      ['put', `${base}/api-version`],
      ['get', `${base}/logs`],
      ['get', `${base}/usage`],
    ];
    for (const [method, path] of calls) {
      const res = await (
        http() as unknown as Record<string, (p: string) => supertest.Test>
      )[method](path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(res.body.code).toEqual(expect.any(String));
      expect(res.body.code).not.toBe('not_found');
    }
    expect((await http().get(`${base}/unknown-route`)).status).toBe(404);
  });

  it('S42 AS-67: GET /api/developers/openapi.json is served by the started application without a session', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/api/developers/openapi.json')
      .expect(200);
    expect(res.body.openapi).toMatch(/^3\.1/);
    expect(Object.keys(res.body.paths)).toContain('/v1/products');
  });
});
