import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { publicApiRequestContext } from '@app/domains/developer-platform';
import { PolicyRegistry } from '@app/infrastructure/rate-limit/policy-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { PublicApiAppModule } from './public-api-app.module';

/**
 * The real public-api application, not a module a spec assembled (S42 L-004, L-015, L-018): `PublicApiAppModule` starts
 * on its own, every `/v1` route of the contract is mapped in it, and it declares the two rate policies. A missing
 * import or a route that did not get registered fails here, where a spec that builds its own small module cannot see it.
 */
describe('Public API wiring in the real public-api application', () => {
  let app: INestApplication;

  const start = async () => {
    const created = await NestFactory.create(PublicApiAppModule, {
      logger: false,
      abortOnError: false,
    });
    configureHttpApp(created, {
      globalPrefix: false,
      cors: false,
      useStructuredLogger: false,
      processHandlers: false,
      beforeBodyParsing: [publicApiRequestContext(created)],
    });
    await created.listen(0, '127.0.0.1');
    return created;
  };

  beforeAll(async () => {
    app = await start();
  }, 120_000);
  afterAll(() => app?.close());

  const id = '0192f3a0-0000-7000-8000-000000000001';

  it('S42 AS-65: every /v1 route is mapped in the started application (a mapped route answers 401 problem+json, an unmapped one 404)', async () => {
    const http = () => supertest(app.getHttpServer());
    const calls: Array<[string, string]> = [
      ['get', '/v1/products'],
      ['post', '/v1/products'],
      ['get', `/v1/products/${id}`],
      ['patch', `/v1/products/${id}`],
      ['get', `/v1/stock/${id}`],
      ['post', '/v1/stock/bulk'],
      ['get', '/v1/stock/bulk/bsu_0192f3a0000070008000000000000001'],
      ['get', '/v1/orders'],
      ['get', `/v1/orders/${id}`],
      ['post', '/v1/batch'],
    ];
    for (const [method, path] of calls) {
      const res = await (
        http() as unknown as Record<string, (p: string) => supertest.Test>
      )[method](path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body.code).toBe('invalid_api_key');
    }
    const unmapped = await http().get('/v1/unknown-route');
    expect(unmapped.status).toBe(404);
  });

  it('S42 AS-55: the started application declares both public API rate policies', () => {
    const registry = app.get(PolicyRegistry);
    expect(registry.has('public-api.default')).toBe(true);
    expect(registry.has('public-api.auth-failure.ip')).toBe(true);
  });

  it('S42 AS-21: the application refuses to start without the key-hashing secret', async () => {
    const saved = process.env.API_KEY_PEPPER;
    delete process.env.API_KEY_PEPPER;
    try {
      await expect(start()).rejects.toThrow(/api_key_pepper/i);
    } finally {
      process.env.API_KEY_PEPPER = saved;
    }
  }, 120_000);
});
