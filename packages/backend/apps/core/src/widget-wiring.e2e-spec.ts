import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import supertest from 'supertest';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CoreModule } from './core.module';

/**
 * The real core application, not a module a spec assembled (S44 L-004, L-015, L-018): `CoreModule` starts, the widget
 * dashboard and public routes are mapped in it, the per-site CORS policy replaces the application one for them, and the
 * required widget token key is configured.
 */
describe('Widget wiring in the real core application', () => {
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
  const id = '0192f3a0-0000-7000-8000-000000000001';
  const key = `pk_live_${'a'.repeat(24)}`;

  it('S44 AS-17: an unknown well-formed key answers 404 widget_site_not_found from the started application', async () => {
    const res = await http()
      .get(`/api/widget/v1/config?key=${key}`)
      .set('Origin', 'https://www.my-shop.com')
      .expect(404);
    expect(res.body.code).toBe('widget_site_not_found');
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('S44 AS-18: the global CORS policy does not answer widget preflights; the widget does', async () => {
    const res = await http()
      .options(`/api/widget/v1/identify?key=${key}`)
      .set('Origin', 'https://www.my-shop.com')
      .set('Access-Control-Request-Method', 'POST')
      .expect(403);
    expect(res.body.code).toBe('origin_not_allowed');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('S44 AS-09: every dashboard route is mapped in the started application (401 problem+json for an anonymous caller, never a 404)', async () => {
    const base = `/api/shops/${id}/widget/sites`;
    const calls: Array<[string, string]> = [
      ['post', base],
      ['get', base],
      ['get', `${base}/${id}`],
      ['patch', `${base}/${id}`],
      ['post', `${base}/${id}/rotate-secret`],
      ['post', `${base}/${id}/expire-previous-secret`],
      ['put', `${base}/${id}/kill-switch`],
      ['delete', `${base}/${id}`],
      ['get', `${base}/${id}/history`],
    ];
    for (const [method, path] of calls) {
      const res = await (
        http() as unknown as Record<string, (p: string) => supertest.Test>
      )[method](path);
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(res.body.code).not.toBe('not_found');
    }
  });

  it('S44 AS-34: the embed route is mapped and refuses an unknown key without a body that could be framed', async () => {
    const res = await http().get(`/api/widget/v1/embed?key=${key}`).expect(404);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });
});
