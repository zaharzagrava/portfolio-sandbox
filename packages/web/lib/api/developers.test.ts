import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { OpenApiInvalidError, developersApi, getOpenApiDocument } from './developers';

const document = { openapi: '3.1.0', info: { title: 'Seller API', version: '2026-10-01' }, paths: { '/v1/products': { get: { summary: 'List', tags: ['products'] } } } };

describe('W07 listKeys reads the S42 page of keys (drift repair)', () => {
  it('W07 S42 follow-up: a page {items, nextCursor} is unwrapped and a revoked key carries its status', async () => {
    server.use(
      http.get('*/api/shops/shop-1/developers/keys', () =>
        HttpResponse.json({
          items: [
            { id: 'k1', prefix: 'sk_test_aaaa', name: 'CI', scopes: ['products:read'], livemode: false, status: 'active', expiresAt: null, lastUsedAt: null, createdBy: 'u1', createdAt: '2026-10-01T00:00:00.000Z' },
            { id: 'k2', prefix: 'sk_test_bbbb', name: 'Old', scopes: ['orders:read'], livemode: false, status: 'revoked', expiresAt: null, lastUsedAt: null, createdBy: 'u1', createdAt: '2026-09-01T00:00:00.000Z' },
          ],
          nextCursor: null,
        }),
      ),
    );
    const keys = await developersApi.listKeys('shop-1');
    expect(keys.map((key) => [key.id, key.status])).toEqual([['k1', 'active'], ['k2', 'revoked']]);
  });
});

describe('W07 getOpenApiDocument (FR-031)', () => {
  it('W07 AS-27: reads the same-origin route and returns the validated description', async () => {
    let requested = '';
    server.use(
      http.get('*/api/developers/openapi.json', ({ request }) => {
        requested = new URL(request.url).pathname;
        return HttpResponse.json(document);
      }),
    );
    const result = await getOpenApiDocument();
    expect(requested).toBe('/api/developers/openapi.json');
    expect(result.openapi).toBe('3.1.0');
    expect(Object.keys(result.paths)).toEqual(['/v1/products']);
  });

  it('W07 AS-28: an answer that is not an OpenAPI 3.x description is a typed failure, not a document', async () => {
    for (const body of [{ openapi: '2.0', info: { title: 'x' }, paths: {} }, { hello: 'world' }, '<html>nope</html>']) {
      server.use(http.get('*/api/developers/openapi.json', () => HttpResponse.json(body as never)));
      await expect(getOpenApiDocument()).rejects.toBeInstanceOf(OpenApiInvalidError);
    }
  });

  it('W07 AS-28: a 503 problem surfaces as the request error that carries its requestId', async () => {
    server.use(
      http.get('*/api/developers/openapi.json', () =>
        HttpResponse.json({ status: 503, code: 'service_unavailable', requestId: 'req-123' }, { status: 503, headers: { 'content-type': 'application/problem+json' } }),
      ),
    );
    await expect(getOpenApiDocument()).rejects.toMatchObject({ response: { status: 503, data: { requestId: 'req-123' } } });
  });

  it('W07 AS-37: the module holds no absolute API address', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(`${__dirname}/developers.ts`, 'utf8');
    expect(source).not.toMatch(/https?:\/\/(localhost|\d)/);
    expect(source).not.toContain('NEXT_PUBLIC_');
  });
});
