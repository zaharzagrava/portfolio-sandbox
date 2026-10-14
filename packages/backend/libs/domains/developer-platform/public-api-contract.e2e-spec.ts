import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  batchResultSchema,
  bulkStockJobSchema,
  bulkStockSyncResultSchema,
  publicApiProblemSchema,
  publicApiV20260115,
  publicApiV20261001,
  PUBLIC_API_ERROR_CODES,
} from '@marketplace-sandbox/contracts';
import { RequestRecordSink } from './infra/request-record.sink';
import {
  createKey,
  createPublicApiKit,
  exec,
  fastStoreOf,
  newId,
  seedOrder,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import { PublicCatalogService } from './application/public-catalog.service';
import { API_ERROR_CATALOGUE } from './domain/errors';
import { PUBLIC_ROUTES } from './domain/public-routes';
import { fieldNamesAt } from './domain/versioning';
import {
  ORDER_FIELD_SAMPLE,
  PRODUCT_FIELD_SAMPLE,
} from './domain/public-views';

const limiterPolicy = developerPlatformRatePolicies.policies[
  'public-api.default'
] as {
  limit: number;
  localLeaseFraction?: number;
};
const product = (over: Record<string, unknown> = {}) => ({
  title: 'Mug',
  price: { amount: 1_000, currency: 'USD' },
  stock: 5,
  category: 'kitchen',
  brand: 'Acme',
  ...over,
});
const REPO = resolve(__dirname, '../../../../..');

describe('Public API: problem details, OpenAPI, contracts and transport defaults', () => {
  let t: PublicApiKit;
  let pub: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit();
    pub = t.pub;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (
    scopes?: string[],
  ): Promise<{ w: ShopWorld; key: CreatedKey }> => {
    const w = await t.seedWorld();
    return { w, key: await createKey(t, w, scopes ? { scopes } : {}) };
  };
  const api = (key: CreatedKey) => pub.withKey(key.key);
  const create = (key: CreatedKey, body: object = product()) =>
    api(key).post('/v1/products').set('Idempotency-Key', newId()).send(body);

  describe('AS-65 every error is a problem document', () => {
    it('S42 AS-65: the catalogue of the code equals the contract’s list', () => {
      expect(Object.keys(API_ERROR_CATALOGUE).sort()).toEqual(
        [...PUBLIC_API_ERROR_CODES].sort(),
      );
    });

    it('S42 AS-65: every error class answers application/problem+json with the documented members, a stable type and a code of the contract', async () => {
      const { w, key } = await world();
      const readOnly = await createKey(t, w, { scopes: ['orders:read'] });
      const made = await create(key).expect(201);
      const id = made.body.id as string;
      const catalog = pub.app.get(PublicCatalogService);
      const answers: Array<
        [
          number,
          Promise<{
            status: number;
            headers: Record<string, string>;
            body: any;
          }>,
        ]
      > = [];
      const send = async (p: PromiseLike<any>) => p as Promise<any>;

      answers.push([400, send(api(key).get('/v1/products?limit=0'))]);
      answers.push([401, send(pub.http().get('/v1/products'))]);
      answers.push([403, send(api(readOnly).get('/v1/products'))]);
      answers.push([404, send(api(key).get(`/v1/products/${newId()}`))]);
      answers.push([405, send(api(key).delete('/v1/products'))]);
      answers.push([
        406,
        send(api(key).get('/v1/products').set('Accept', 'text/html')),
      ]);
      answers.push([
        412,
        send(
          api(key)
            .patch(`/v1/products/${id}`)
            .set('If-Match', '"9"')
            .send({ title: 'x' }),
        ),
      ]);
      answers.push([
        415,
        send(
          api(key)
            .post('/v1/products')
            .set('Idempotency-Key', newId())
            .set('Content-Type', 'text/plain')
            .send('title=x'),
        ),
      ]);
      answers.push([422, send(api(key).post('/v1/products').send(product()))]);
      answers.push([
        428,
        send(api(key).patch(`/v1/products/${id}`).send({ title: 'x' })),
      ]);
      const results: Array<[number, any]> = [];
      for (const [status, pending] of answers)
        results.push([status, await pending]);

      const spy = jest
        .spyOn(catalog, 'list')
        .mockRejectedValueOnce(
          new Error('select * from "Product" where password=hunter2'),
        );
      try {
        results.push([500, await api(key).get('/v1/products')]);
      } finally {
        spy.mockRestore();
      }
      limiterPolicy.limit = 1;
      limiterPolicy.localLeaseFraction = undefined;
      try {
        await api(key).get('/v1/products');
        results.push([429, await api(key).get('/v1/products')]);
      } finally {
        limiterPolicy.limit = 6000;
        limiterPolicy.localLeaseFraction = 0.05;
      }
      t.clock.set(new Date('2027-04-01T00:00:00.000Z'));
      results.push([410, await api(key).get(`/v1/products/${id}/stock`)]);
      t.clock.set(new Date('2026-10-06T12:00:00.000Z'));
      const store = fastStoreOf(t.app);
      await store.deny('rl:');
      try {
        results.push([
          503,
          await pub.withKey('sk_live_nope').get('/v1/products'),
        ]);
      } finally {
        await store.allow();
      }
      results.push([
        409,
        await (async () => {
          const target = (await create(key).expect(201)).body.id as string;
          await exec(
            t.app,
            `UPDATE "Product" SET status = 'ARCHIVED' WHERE id = :id`,
            { id: target },
          );
          return api(key)
            .patch(`/v1/products/${target}`)
            .set('If-Match', '"1"')
            .send({ title: 'x' });
        })(),
      ]);
      results.push([
        413,
        await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024 + 16) })),
      ]);

      for (const [status, res] of results) {
        expect({ status, got: res.status }).toEqual({ status, got: status });
        expect(res.headers['content-type']).toContain(
          'application/problem+json',
        );
        const problem = publicApiProblemSchema.parse(res.body);
        expect(PUBLIC_API_ERROR_CODES as readonly string[]).toContain(
          problem.code,
        );
        expect(problem.type).toMatch(new RegExp(`/${problem.code}$`));
        expect(problem.requestId).toBe(res.headers['request-id']);
        expect(problem.instance.startsWith('/v1/')).toBe(true);
        if (status >= 500) {
          expect(problem.detail).toBe(
            'The server could not complete the request. Please try again later.',
          );
          expect(JSON.stringify(problem)).not.toMatch(
            /hunter2|select \*|Error:/,
          );
        }
      }
    });

    it('S42 AS-65: a validation error names fields and codes and never echoes a value', async () => {
      const { key } = await world();
      const res = await create(
        key,
        product({
          price: { amount: 'SECRET-VALUE-123', currency: 'USD' },
          title: '',
        }),
      ).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual(
        expect.arrayContaining(['price.amount', 'title']),
      );
      expect(JSON.stringify(res.body)).not.toContain('SECRET-VALUE-123');
    });
  });

  describe('AS-66 body limits and media types', () => {
    it('S42 AS-66: over 2 MiB is 413, just under it is read; the other refusals never reach a handler and each is logged against the valid key', async () => {
      const { key } = await world();
      const catalog = pub.app.get(PublicCatalogService);
      const spy = jest.spyOn(catalog, 'create');
      try {
        const big = await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024 + 16) }));
        expect(big.status).toBe(413);
        expect(big.body.code).toBe('payload_too_large');
        const under = await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ title: 'x'.repeat(1_900_000) }));
        expect(under.status).toBe(400);
        expect(under.body.code).toBe('validation_failed');

        const media = await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Content-Type', 'text/plain')
          .send('x');
        expect(media.status).toBe(415);
        expect(media.body.code).toBe('unsupported_media_type');
        const syntax = await api(key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .set('Content-Type', 'application/json')
          .send('{"title":');
        expect(syntax.status).toBe(400);
        const accept = await api(key)
          .get('/v1/products')
          .set('Accept', 'text/html');
        expect(accept.status).toBe(406);
        expect(accept.body.code).toBe('not_acceptable');
        expect(spy).not.toHaveBeenCalled();

        await t.flushRecords();
        for (const [label, res] of [
          ['413', big],
          ['415', media],
          ['400', syntax],
          ['406', accept],
        ] as const) {
          const logged = t.records.of(res.headers['request-id']);
          expect({ label, n: logged.length }).toEqual({ label, n: 1 });
          expect(logged[0].keyId).toBe(key.id);
          expect(logged[0].status).toBe(res.status);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-66: Accept ranges that include JSON are served', async () => {
      const { key } = await world();
      for (const accept of [
        'application/json',
        '*/*',
        'application/*',
        'text/html;q=0.5, application/json',
        'application/problem+json',
      ])
        expect(
          (await api(key).get('/v1/products').set('Accept', accept)).status,
        ).toBe(200);
    });
  });

  describe('AS-67, AS-36 the contract is published and tested', () => {
    const fetchDoc = async () =>
      (await pub.http().get('/v1/openapi.json').expect(200)).body;

    const resolveRef = (doc: any, ref: string) => {
      expect(ref.startsWith('#/')).toBe(true);
      return ref
        .slice(2)
        .split('/')
        .reduce((node: any, key) => node?.[key], doc);
    };
    const refs = (node: unknown, found: string[] = []): string[] => {
      if (Array.isArray(node)) node.forEach((n) => refs(n, found));
      else if (node && typeof node === 'object')
        for (const [k, v] of Object.entries(node))
          if (k === '$ref') found.push(v as string);
          else refs(v, found);
      return found;
    };

    it('S42 AS-67: it is served without authentication, from both surfaces, is valid OpenAPI 3.1 and holds no key', async () => {
      const doc = await fetchDoc();
      const dashboard = (
        await t.http().get('/api/developers/openapi.json').expect(200)
      ).body;
      expect(dashboard).toEqual(doc);
      expect(doc.openapi).toMatch(/^3\.1\./);
      expect(doc.info.title).toBeTruthy();
      expect(JSON.stringify(doc)).not.toMatch(
        /sk_(live|test)_[A-Za-z0-9]{12}_[A-Za-z0-9]{32}/,
      );
      expect(JSON.stringify(doc)).not.toContain('"nullable"');
      for (const ref of refs(doc))
        expect({ ref, found: resolveRef(doc, ref) !== undefined }).toEqual({
          ref,
          found: true,
        });

      const schemes = Object.keys(doc.components.securitySchemes);
      for (const [path, ops] of Object.entries<any>(doc.paths))
        for (const [method, op] of Object.entries<any>(ops)) {
          expect({ path, method, id: typeof op.operationId }).toEqual({
            path,
            method,
            id: 'string',
          });
          expect(Object.keys(op.responses).length).toBeGreaterThan(0);
          for (const requirement of op.security ?? [])
            for (const name of Object.keys(requirement))
              expect(schemes).toContain(name);
        }
      // every component is a JSON Schema object that says what it describes
      for (const [name, schema] of Object.entries<any>(
        doc.components.schemas,
      )) {
        const describes = [
          'type',
          'oneOf',
          'anyOf',
          'allOf',
          '$ref',
          'const',
          'properties',
        ].some((k) => k in schema);
        expect({ name, describes }).toEqual({ name, describes: true });
      }
    });

    it('S42 AS-67: every route, scope, version header, Idempotency-Key, If-Match, pagination, fields and problem schema is described', async () => {
      const doc = await fetchDoc();
      for (const route of PUBLIC_ROUTES) {
        const op = doc.paths[route.path]?.[route.method];
        expect({ route: route.template, described: op !== undefined }).toEqual({
          route: route.template,
          described: true,
        });
        expect(op.security).toEqual([
          { bearerAuth: route.scope ? [route.scope] : [] },
        ]);
        const params = JSON.stringify(op.parameters);
        expect(params).toContain('MarketplaceVersion');
        if (route.idempotencyKey) expect(params).toContain('IdempotencyKey');
        if (route.ifMatch) expect(params).toContain('IfMatch');
        if (route.success.list)
          for (const p of ['Limit', 'Cursor', 'Fields', 'Expand'])
            expect(params).toContain(p);
        for (const status of [401, 403, 429])
          expect(op.responses[String(status)]).toBeDefined();
        expect(JSON.stringify(op.responses[String(route.errors[0])])).toContain(
          'Problem',
        );
      }
      expect(
        doc.paths['/v1/products/{id}/stock'].get.responses['410'],
      ).toBeDefined();
      expect(doc.paths['/v1/orders'].get.responses['400']).toBeDefined();
    });

    it('S42 AS-36: every deprecated route is flagged with its sunset and replacement, and only those announce themselves', async () => {
      const doc = await fetchDoc();
      const flagged = Object.entries<any>(doc.paths).flatMap(([path, ops]) =>
        Object.entries<any>(ops)
          .filter(([, op]) => op.deprecated === true)
          .map(([method]) => `${method} ${path}`),
      );
      expect(flagged).toEqual(['get /v1/products/{id}/stock']);
      const op = doc.paths['/v1/products/{id}/stock'].get;
      expect(op['x-sunset']).toBe('2027-04-01T00:00:00Z');
      expect(op['x-replacement']).toBe('/v1/stock/{productId}');

      const { key } = await world();
      const made = await create(key).expect(201);
      for (const route of PUBLIC_ROUTES.filter(
        (r) => r.method === 'get' && !r.path.includes('bulk'),
      )) {
        const path = route.path
          .replace('{id}', made.body.id)
          .replace('{productId}', made.body.id);
        const res = await api(key).get(path);
        const announces = res.headers['deprecation'] !== undefined;
        expect({ path, announces }).toEqual({
          path,
          announces: route.template === '/v1/products/:id/stock',
        });
      }
    });

    it('S42 AS-67: real responses parse against the contract schemas of every supported version', async () => {
      const { w, key } = await world();
      const buyer = await t.newUser();
      const made = await create(key).expect(201);
      await seedOrder(t.app, {
        buyerId: buyer.id,
        lines: [
          {
            productId: made.body.id,
            shopId: w.shop.id,
            quantity: 2,
            unitPriceMinor: 1_000,
          },
        ],
      });
      const at = (version: string) => (url: string) =>
        api(key).get(url).set('Marketplace-Version', version).expect(200);
      const latest = at('2026-10-01');
      const old = at('2026-01-15');

      publicApiV20261001.productSchema.parse(
        (await latest(`/v1/products/${made.body.id}`)).body,
      );
      publicApiV20261001
        .listSchema(publicApiV20261001.productSchema)
        .parse((await latest('/v1/products')).body);
      publicApiV20261001.orderSchema.parse(
        (await latest('/v1/orders')).body.data[0],
      );
      publicApiV20261001.stockSchema.parse(
        (await latest(`/v1/stock/${made.body.id}`)).body,
      );
      publicApiV20260115.productSchema.parse(
        (await old(`/v1/products/${made.body.id}`)).body,
      );
      publicApiV20261001
        .listSchema(publicApiV20260115.productSchema)
        .parse((await old('/v1/products')).body);
      publicApiV20260115.orderSchema.parse(
        (await old('/v1/orders')).body.data[0],
      );

      const bulk = await api(key)
        .post('/v1/stock/bulk')
        .set('Idempotency-Key', newId())
        .send({
          items: [{ operationId: 'a', productId: made.body.id, delta: 1 }],
        })
        .expect(200);
      bulkStockSyncResultSchema.parse(bulk.body);
      const batch = await api(key)
        .post('/v1/batch')
        .set('Idempotency-Key', newId())
        .send({ operations: [{ method: 'GET', path: '/v1/products' }] })
        .expect(200);
      batchResultSchema.parse(batch.body);
      void bulkStockJobSchema;
    });

    it('S42 AS-36: changes within a version are additive: no field of the baseline disappears', () => {
      const baseline: Record<string, Record<string, string[]>> = {
        '2026-10-01': {
          product: [
            'id',
            'object',
            'livemode',
            'title',
            'description',
            'price',
            'stock',
            'category',
            'brand',
            'status',
            'version',
            'created_at',
            'updated_at',
          ],
          order: [
            'id',
            'object',
            'livemode',
            'status',
            'total',
            'lines',
            'created_at',
          ],
        },
        '2026-01-15': {
          product: [
            'id',
            'object',
            'livemode',
            'title',
            'description',
            'price',
            'quantity',
            'category',
            'brand',
            'status',
            'version',
            'created_at',
            'updated_at',
          ],
          order: [
            'id',
            'object',
            'livemode',
            'status',
            'total',
            'currency',
            'lines',
            'created_at',
          ],
        },
      };
      for (const [version, resources] of Object.entries(baseline)) {
        const product = fieldNamesAt('product', version, PRODUCT_FIELD_SAMPLE);
        const order = fieldNamesAt('order', version, ORDER_FIELD_SAMPLE);
        for (const name of resources.product)
          expect({ version, name, kept: product.includes(name) }).toEqual({
            version,
            name,
            kept: true,
          });
        for (const name of resources.order)
          expect({ version, name, kept: order.includes(name) }).toEqual({
            version,
            name,
            kept: true,
          });
      }
    });
  });

  describe('AS-68 OWASP mapping', () => {
    it('S42 AS-68: the note maps the ten risks to existing scenarios, each row with an owner', () => {
      const note = readFileSync(
        resolve(REPO, 'docs/security/owasp-api-top-10.md'),
        'utf8',
      );
      const spec = readFileSync(
        resolve(REPO, 'specs/domains/S42-public-api/spec.md'),
        'utf8',
      );
      const rows = note.split('\n').filter((l) => /^\| API\d+ /.test(l));
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        const cells = row.split('|').map((c) => c.trim());
        expect(cells[4]).toBeTruthy();
        const named = [...cells[3].matchAll(/AS-(\d+)/g)].map((m) => m[1]);
        expect(named.length).toBeGreaterThan(0);
        for (const n of named) expect(spec).toContain(`**AS-${n}**`);
      }
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(note).toContain(`| API${n} `);
    });
  });

  describe('AS-69 safe transport defaults', () => {
    it('S42 AS-69: no-store, nosniff, no banner, no CORS grant, no cookies; HEAD is GET without a body; OPTIONS is not served', async () => {
      const { key } = await world();
      const res = await api(key)
        .get('/v1/products')
        .set('Cookie', 'sid=abc')
        .set('Origin', 'https://evil.example');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      for (const banned of [
        'server',
        'x-powered-by',
        'set-cookie',
        'access-control-allow-origin',
        'access-control-allow-credentials',
      ])
        expect({ banned, present: res.headers[banned] !== undefined }).toEqual({
          banned,
          present: false,
        });

      const preflight = await pub
        .http()
        .options('/v1/products')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect([404, 405]).toContain(preflight.status);

      const head = await api(key).head('/v1/products');
      expect(head.status).toBe(200);
      expect(head.text ?? '').toBe('');
      expect(head.headers['content-type']).toContain('application/json');
      const cookieOnly = await pub
        .http()
        .get('/v1/products')
        .set('Cookie', 'session=abc');
      expect(cookieOnly.status).toBe(401);
    });
  });

  describe('AS-71 graceful shutdown', () => {
    it('S42 AS-71: closing an instance publishes the pending request records first', async () => {
      const inst = await t.publicInstance();
      const { key } = await world();
      t.records.down = true;
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1)
        ids.push(
          (await inst.withKey(key.key).get('/v1/products').expect(200)).headers[
            'request-id'
          ],
        );
      expect(t.records.records).toHaveLength(0);
      t.records.down = false;
      await inst.app.get(RequestRecordSink).onModuleDestroy();
      for (const id of ids) expect(t.records.of(id)).toHaveLength(1);
    });
  });
});
