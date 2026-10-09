import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { BffModule } from './bff.module';

/**
 * SD-04: the real BFF (REST aggregate + Apollo GraphQL) against a stub "core"
 * HTTP server that records calls and can be made slow. The BFF has no
 * database by design, so the stub IS its whole world.
 */
describe('BFF (e2e)', () => {
  let app: INestApplication;
  let core: http.Server;
  const calls: string[] = [];
  let slowRecommendations = false;
  const shopId = v4();
  const products = Array.from({ length: 20 }, (_, i) => ({
    id: v4(),
    title: `P${i}`,
    price: 1000 + i,
    quantity: 3,
    category: 'audio',
    shopId,
  }));

  beforeAll(async () => {
    core = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://core');
      calls.push(url.pathname);
      const json = (body: unknown, delay = 0) =>
        setTimeout(
          () =>
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify(body)),
          delay,
        );
      if (url.pathname.startsWith('/api/batch/products'))
        return json(
          url.searchParams
            .get('ids')!
            .split(',')
            .map((id) => products.find((p) => p.id === id) ?? null),
        );
      if (url.pathname.startsWith('/api/batch/shops'))
        return json(
          url.searchParams
            .get('ids')!
            .split(',')
            .map((id) => ({ id, name: 'Audio Shop', slug: 'audio' })),
        );
      if (/\/recommendations$/.test(url.pathname))
        return json(
          [{ productId: products[1].id }],
          slowRecommendations ? 2_000 : 0,
        );
      if (url.pathname.startsWith('/api/products/'))
        return json(products.find((p) => url.pathname.endsWith(p.id)) ?? null);
      if (url.pathname === '/api/trending') return json([]);
      if (url.pathname === '/api/flags')
        return json({ flags: { 'web-new-header': true } });
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => core.listen(0, '127.0.0.1', r));
    const coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [BffModule] })
      .overrideProvider(ApiConfigService)
      .useValue({
        get: (key: string) =>
          ({ core_internal_url: coreUrl, node_env: 'test' })[key],
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    core.close();
  });

  beforeEach(() => {
    calls.length = 0;
    slowRecommendations = false;
  });

  it('product page aggregates in parallel; a slow optional section degrades to a partial response within its budget', async () => {
    slowRecommendations = true;
    const started = Date.now();
    const res = await request(app.getHttpServer())
      .get(`/bff/product-page/${products[0].id}`)
      .expect(200);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.body.product.title).toBe('P0');
    expect(res.body.shop).toMatchObject({ name: 'Audio Shop' });
    expect(res.body.flags).toEqual({ 'web-new-header': true });
    expect(res.body.recommendations).toBeNull();
    expect(res.body.errors).toEqual([
      {
        section: 'recommendations',
        reason: expect.stringContaining('timeout'),
      },
    ]);
  });

  it('GraphQL: 20 products and their shops = one batch call each (DataLoader, no N+1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query: `query($ids: [ID!]!) { products(ids: $ids) { id title shop { name } } }`,
        variables: { ids: products.map((p) => p.id) },
      })
      .expect(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.products).toHaveLength(20);
    expect(
      res.body.data.products.every(
        (p: { shop: { name: string } }) => p.shop.name === 'Audio Shop',
      ),
    ).toBe(true);
    expect(calls.filter((c) => c === '/api/batch/products')).toHaveLength(1);
    expect(calls.filter((c) => c === '/api/batch/shops')).toHaveLength(1);
  });

  it('cost and depth limits reject expensive queries before execution', async () => {
    const ids = JSON.stringify(products.map((p) => p.id));
    const deep = `{ products(ids: ${ids}) { recommendations { recommendations { recommendations { recommendations { recommendations { id } } } } } } }`;
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: deep });
    expect(JSON.stringify(res.body.errors)).toMatch(/exceeds/);
    expect(calls).toEqual([]); // nothing reached core
  });

  it('persisted queries: a known hash executes the stored document; an unknown hash is refused', async () => {
    const known =
      '89fc92a2fb9d8f7fea91d081e3327108d8943005f5b3326f2992320fb669bc10';
    const ok = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        variables: { id: products[0].id },
        extensions: { persistedQuery: { version: 1, sha256Hash: known } },
      })
      .expect(200);
    expect(ok.body.data.product).toMatchObject({
      title: 'P0',
      shop: { name: 'Audio Shop' },
    });

    const unknown = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        extensions: {
          persistedQuery: { version: 1, sha256Hash: 'f'.repeat(64) },
        },
      });
    expect(JSON.stringify(unknown.body)).toContain('PersistedQueryNotFound');
  });
});
