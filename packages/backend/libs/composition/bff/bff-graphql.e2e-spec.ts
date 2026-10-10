import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GraphQLSchema, buildSchema, isObjectType, printSchema } from 'graphql';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { ManualTimeSource } from '@app/infrastructure/rate-limit/time-source';
import {
  BFF_COOKIES,
  graphqlErrorCodeSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import {
  ALLOWED_ORIGIN,
  BffTestApp,
  createBffApp,
  resetBffRedis,
} from './testing/app-factory';
import { chatUnreadFixture, recommendationsFixture } from './testing/fixtures';
import { seedProduct, signIn, waitFor } from './testing/helpers';
import { StubUpstream } from './testing/stub-upstream';
import { BreakerRegistry } from './upstream/breaker-registry';
import { PERSISTED_QUERIES } from './graphql/persisted-queries.allowlist';
import { analyzeQuery } from './graphql/limits';
import { parse } from 'graphql';

const SNAPSHOT = join(__dirname, 'graphql', 'schema.snapshot.graphql');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());
const hashOf = (name: string) =>
  Object.entries(PERSISTED_QUERIES).find(([, text]) =>
    text.includes(`query ${name}`),
  )![0];

interface GqlBody {
  data?: Record<string, any> | null;
  errors?: {
    message: string;
    path?: (string | number)[];
    extensions?: { code?: string };
  }[];
}

describe('BFF GraphQL', () => {
  let stub: StubUpstream;
  let ctx: BffTestApp;

  // trusted documents are enforced everywhere except local development: most specs run against that mode
  beforeAll(async () => {
    stub = await StubUpstream.start();
    ctx = await createBffApp({
      upstreamUrl: stub.url,
      env: { BFF_LOCAL_DEV: 'true' },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await stub.close();
  });
  beforeEach(async () => {
    stub.reset();
    ctx.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
  });

  const post = (body: unknown, app = ctx) =>
    app
      .http()
      .post('/api/graphql')
      .set('Content-Type', 'application/json')
      .send(body as object);
  const gql = (query: string, variables?: Record<string, unknown>, app = ctx) =>
    post({ query, variables }, app);
  const codes = (body: GqlBody) =>
    (body.errors ?? []).map((e) => e.extensions?.code);
  const idsQuery =
    'query($ids: [ID!]!) { products(ids: $ids) { id title shop { name } } }';
  const seedMany = (n: number, shopId = randomUUID()) =>
    Array.from({ length: n }, () => seedProduct(stub, { shopId }));
  /** `n` aliases of `products(ids: <list>) { id title category }`: 200 cost units each for 50 ids. */
  const aliases = (list: string, n = 10) =>
    Array.from(
      { length: n },
      (_, i) => `a${i}: products(ids: ${list}) { id title category }`,
    ).join(' ');
  const withIds = (n = 10) => `query($ids: [ID!]!) { ${aliases('$ids', n)} }`;

  describe('US3 batching without N+1', () => {
    it('S48 AS-25: 20 products and their shops cost one product batch and one shop batch', async () => {
      const products = seedMany(20);
      const res = await gql(idsQuery, {
        ids: products.map((p) => p.id),
      }).expect(200);
      const body = res.body as GqlBody;
      expect(body.errors).toBeUndefined();
      expect(body.data!.products.map((p: { id: string }) => p.id)).toEqual(
        products.map((p) => p.id),
      );
      expect(
        body.data!.products.every(
          (p: { shop: { name: string } }) => p.shop.name === 'Audio Shop',
        ),
      ).toBe(true);
      expect(stub.callsTo('productBatch')).toHaveLength(1);
      expect(stub.callsTo('shopBatch')).toHaveLength(1);
      expect(stub.callsTo('shopBatch')[0].query.ids.split(',')).toHaveLength(1); // one distinct shop
    });

    it('S48 AS-26: duplicates are asked once, hidden items are null in place, no error for them', async () => {
      const [a, c] = seedMany(2);
      const hidden = randomUUID();
      const res = await gql(
        'query($ids: [ID!]!) { products(ids: $ids) { id } }',
        { ids: [a.id, hidden, a.id, c.id] },
      ).expect(200);
      const body = res.body as GqlBody;
      expect(body.errors).toBeUndefined();
      expect(body.data!.products).toEqual([
        { id: a.id },
        null,
        { id: a.id },
        { id: c.id },
      ]);
      expect(stub.callsTo('productBatch')).toHaveLength(1);
      expect(stub.callsTo('productBatch')[0].query.ids).toBe(
        [a.id, hidden, c.id].join(','),
      );
    });

    it('S48 AS-27: 150 distinct ids in three aliased fields are fetched in two calls of 100 and 50', async () => {
      const products = seedMany(150);
      const slice = (i: number) =>
        products.slice(i * 50, i * 50 + 50).map((p) => p.id);
      const res = await gql(
        'query($a: [ID!]!, $b: [ID!]!, $c: [ID!]!) { a: products(ids: $a) { id } b: products(ids: $b) { id } c: products(ids: $c) { id } }',
        { a: slice(0), b: slice(1), c: slice(2) },
      ).expect(200);
      const body = res.body as GqlBody;
      expect(body.errors).toBeUndefined();
      expect(body.data!.a.concat(body.data!.b, body.data!.c)).toHaveLength(150);
      expect(
        stub
          .callsTo('productBatch')
          .map((c) => c.query.ids.split(',').length)
          .sort((x, y) => x - y),
      ).toEqual([50, 100]);
    });

    it('S48 AS-28: concurrent principals use their own credentials, nothing is shared, and a repeat repeats the calls', async () => {
      const [p] = seedMany(1);
      stub.respond('chatUnread', (call) => ({
        body: {
          items: [
            {
              channelId: String(call.headers.authorization),
              unread: 1,
              lastSeq: 1,
            },
          ],
          nextCursor: null,
        },
      }));
      const query =
        'query($id: ID!) { product(id: $id) { id } chatUnread { items { channelId } } }';
      const as = (token: string) =>
        post({ query, variables: { id: p.id } })
          .set('Authorization', `Bearer ${token}`)
          .then((r) => r);
      const [a, b] = await Promise.all([as('token-A'), as('token-B')]);
      expect((a.body as GqlBody).data!.chatUnread.items[0].channelId).toBe(
        'Bearer token-A',
      );
      expect((b.body as GqlBody).data!.chatUnread.items[0].channelId).toBe(
        'Bearer token-B',
      );
      expect(stub.callsTo('productBatch')).toHaveLength(2); // one batch per request, none shared
      for (const call of stub.callsTo('productBatch'))
        expect(call.headers.authorization).toBeUndefined();
      await gql('query($id: ID!) { product(id: $id) { id } }', {
        id: p.id,
      }).expect(200);
      await gql('query($id: ID!) { product(id: $id) { id } }', {
        id: p.id,
      }).expect(200);
      expect(stub.callsTo('productBatch')).toHaveLength(4);
    });

    it('S48 AS-29: a failed product batch is reported once per path with a stable code; unrelated fields are intact', async () => {
      const products = seedMany(5);
      stub.respond('productBatch', {
        status: 503,
        body: {
          detail: 'secret upstream text',
          url: 'http://10.0.0.7/internal',
        },
      });
      const res = await gql(
        'query($ids: [ID!]!, $id: ID!, $shop: ID!) { products(ids: $ids) { id } product(id: $id) { shop { name } } shop(id: $shop) { name } }',
        {
          ids: products.map((p) => p.id),
          id: products[0].id,
          shop: products[0].shopId,
        },
      ).expect(200);
      const body = res.body as GqlBody;
      expect(body.data!.products).toBeNull();
      expect(body.data!.product).toBeNull();
      expect(body.data!.shop).toEqual({ name: 'Audio Shop' });
      expect(body.errors!.map((e) => [e.path, e.extensions?.code])).toEqual([
        [['products'], 'UPSTREAM_UNAVAILABLE'],
        [['product'], 'UPSTREAM_UNAVAILABLE'],
      ]);
      expect(JSON.stringify(body)).not.toMatch(
        /secret|10\.0\.0\.7|http:|stack/i,
      );
      for (const e of body.errors!)
        graphqlErrorCodeSchema.parse(e.extensions!.code);
    });

    it('S48 AS-30: a recommendations timeout nulls only that field; recommended products hydrate through one batch', async () => {
      const [p, r1, r2] = seedMany(3);
      stub.respond('recommendations', { delayMs: 500 });
      const q =
        'query($id: ID!) { product(id: $id) { id recommendations { id title } } }';
      const slow = (await gql(q, { id: p.id }).expect(200)).body as GqlBody;
      expect(slow.data!.product.id).toBe(p.id);
      expect(slow.data!.product.recommendations).toBeNull();
      expect(slow.errors).toHaveLength(1);
      expect(slow.errors![0].path).toEqual(['product', 'recommendations']);
      expect(slow.errors![0].extensions!.code).toBe('UPSTREAM_TIMEOUT');

      stub.reset();
      stub.products.set(p.id, p);
      stub.products.set(r1.id, r1);
      stub.products.set(r2.id, r2);
      stub.respond('recommendations', {
        body: recommendationsFixture([r1.id, r2.id]),
      });
      const ok = (await gql(q, { id: p.id }).expect(200)).body as GqlBody;
      expect(ok.errors).toBeUndefined();
      expect(
        ok.data!.product.recommendations.map((x: { id: string }) => x.id),
      ).toEqual([r1.id, r2.id]);
      expect(stub.callsTo('productBatch').map((c) => c.query.ids)).toEqual([
        p.id,
        `${r1.id},${r2.id}`,
      ]);
    });
  });

  describe('US3 limits before any upstream call', () => {
    const rejected = async (
      query: string,
      variables?: Record<string, unknown>,
      status = 400,
    ) => {
      const res = await gql(query, variables).expect(status);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stub.calls).toHaveLength(0);
      return res.body as GqlBody;
    };
    const deep = (n: number) =>
      `{ product(id: "${randomUUID()}") ${'{ recommendations '.repeat(n)}{ id }${' }'.repeat(n)} }`;

    it('S48 AS-31: a query deeper than 6 levels is 400 QUERY_TOO_DEEP', async () => {
      const body = await rejected(deep(5));
      expect(codes(body)).toEqual(['QUERY_TOO_DEEP']);
    });

    it('S48 AS-32: an over-priced query is 400 QUERY_TOO_COSTLY whether the ids are literals or a variable; 2,000 exactly runs', async () => {
      const ids = uuids(50);
      const literal = JSON.stringify(
        Array.from({ length: 50 }, (_, i) => String(i)),
      ); // short, so it fits the 8 KB document cap
      expect(codes(await rejected(`{ ${aliases(literal, 11)} }`))).toEqual([
        'QUERY_TOO_COSTLY',
      ]);
      expect(codes(await rejected(withIds(11), { ids }))).toEqual([
        'QUERY_TOO_COSTLY',
      ]);

      const limits = {
        maxDepth: 6,
        maxCost: 2_000,
        maxRootFields: 20,
        maxIds: 50,
      };
      expect(
        analyzeQuery(parse(withIds(10)), { ids }, undefined, limits),
      ).toMatchObject({ cost: 2_000, ok: true });
      const ok = await gql(withIds(10), { ids }).expect(200);
      expect((ok.body as GqlBody).errors).toBeUndefined();
    });

    it('S48 AS-32: a fragment cycle is a validation error, never a loop', async () => {
      const body = await rejected(
        `query { product(id: "${randomUUID()}") { ...A } } fragment A on Product { id ...B } fragment B on Product { title ...A }`,
      );
      expect(codes(body)).toEqual(['GRAPHQL_VALIDATION_FAILED']);
    });

    it('S48 AS-33: 21 root fields are refused, array batching, oversize and wrong media type are problems', async () => {
      const roots = (n: number) =>
        `{ ${Array.from({ length: n }, (_, i) => `a${i}: product(id: "${randomUUID()}") { id }`).join(' ')} }`;
      expect(codes(await rejected(roots(21)))).toEqual([
        'TOO_MANY_ROOT_FIELDS',
      ]);

      const array = await post([
        { query: '{ __typename }' },
        { query: '{ __typename }' },
      ]).expect(400);
      expect(problemDetailsSchema.parse(array.body).code).toBe(
        'batching_not_supported',
      );
      const big = await post({
        query: `{ __typename } # ${'x'.repeat(9_000)}`,
      }).expect(413);
      expect(problemDetailsSchema.parse(big.body).code).toBe(
        'payload_too_large',
      );
      const media = await ctx
        .http()
        .post('/api/graphql')
        .set('Content-Type', 'text/plain')
        .send('{ __typename }');
      expect(media.status).toBe(415);
      expect(problemDetailsSchema.parse(media.body).code).toBe(
        'unsupported_media_type',
      );
      expect(stub.calls).toHaveLength(0);
    });

    it('S48 AS-34: input bounds are rejected, never truncated; an empty list is an empty result', async () => {
      const tooMany = await rejected(
        'query($ids: [ID!]!) { products(ids: $ids) { id } }',
        { ids: uuids(51) },
      );
      expect(codes(tooMany)).toEqual(['BAD_USER_INPUT']);
      expect(tooMany.errors![0].message).toMatch(/ids/);
      expect(tooMany.errors![0].message).toMatch(/50/);
      expect(
        codes(
          await rejected('query($ids: [ID!]!) { products(ids: $ids) { id } }', {
            ids: ['not-a-uuid'],
          }),
        ),
      ).toEqual(['BAD_USER_INPUT']);
      expect(codes(await rejected(`{ product(id: "nope") { id } }`))).toEqual([
        'BAD_USER_INPUT',
      ]);
      const first = await rejected(
        `{ product(id: "${randomUUID()}") { recommendations(first: 51) { id } } }`,
      );
      expect(codes(first)).toEqual(['BAD_USER_INPUT']);
      expect(first.errors![0].message).toMatch(/first/);

      const empty = (
        await gql('query($ids: [ID!]!) { products(ids: $ids) { id } }', {
          ids: [],
        }).expect(200)
      ).body as GqlBody;
      expect(empty.data!.products).toEqual([]);
      expect(stub.calls).toHaveLength(0);
    });

    it('S48 AS-40: introspection works outside production; mutations and subscriptions are refused', async () => {
      const intro = (await gql('{ __schema { types { name } } }').expect(200))
        .body as GqlBody;
      expect(intro.data!.__schema.types.length).toBeGreaterThan(5);
      expect(codes(await rejected('mutation { doIt }'))).toEqual([
        'GRAPHQL_VALIDATION_FAILED',
      ]);
      expect(codes(await rejected('subscription { tick }'))).toEqual([
        'GRAPHQL_VALIDATION_FAILED',
      ]);
    });
  });

  describe('US3 operation deadline and cost budget', () => {
    it('S48 AS-35: the operation answers within 2.1 s; unfinished fields are null with BUDGET_EXCEEDED and the upstream call is aborted', async () => {
      const patient = await createBffApp({
        upstreamUrl: stub.url,
        env: { BFF_LOCAL_DEV: 'true', BFF_BUDGET_PRODUCT_MS: '8000' },
      });
      try {
        const products = seedMany(2);
        stub.respond('productBatch', { delayMs: 5_000 });
        const started = Date.now();
        const res = await gql(
          idsQuery,
          { ids: products.map((p) => p.id) },
          patient,
        ).expect(200);
        expect(Date.now() - started).toBeLessThanOrEqual(2_100);
        const body = res.body as GqlBody;
        expect(body.data!.products).toBeNull();
        expect(codes(body)).toEqual(['BUDGET_EXCEEDED']);
        await waitFor(
          () => stub.callsTo('productBatch')[0].aborted,
          1_000,
          'the upstream abort',
        );
      } finally {
        await patient.close();
      }
    }, 15_000);

    it('S48 AS-35: with the standard call budgets a slow upstream is cut by its own budget, still within the operation deadline', async () => {
      const products = seedMany(2);
      stub.respond('productBatch', { delayMs: 5_000 });
      const started = Date.now();
      const body = (
        await gql(idsQuery, { ids: products.map((p) => p.id) }).expect(200)
      ).body as GqlBody;
      expect(Date.now() - started).toBeLessThanOrEqual(2_100);
      expect(codes(body)).toEqual(['UPSTREAM_TIMEOUT']);
    }, 15_000);

    it('S48 AS-36: the cost budget (20,000 units a minute) is charged by computed cost; a rejected query costs 1; others are unaffected', async () => {
      // store time is moved by hand, so the bucket does not refill while the test runs
      const limited = await createBffApp({
        upstreamUrl: stub.url,
        env: {
          BFF_LOCAL_DEV: 'true',
          TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1',
        },
        rateLimitTime: new ManualTimeSource(1_900_000_000_000),
      });
      try {
        await resetBffRedis(limited.redis);
        const ids = uuids(50);
        const as = (
          ip: string,
          query: string,
          variables?: Record<string, unknown>,
        ) =>
          limited
            .http()
            .post('/api/graphql')
            .set({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip })
            .send({ query, variables });
        const remaining = (res: { headers: Record<string, unknown> }) =>
          Number(/r=(\d+)/.exec(String(res.headers['ratelimit']))![1]);

        const first = await as('198.51.100.1', withIds(), { ids }).expect(200);
        expect(remaining(first)).toBe(18_000);
        const bad = await as(
          '198.51.100.1',
          '{ product(id: "nope") { id } }',
        ).expect(400);
        expect(remaining(bad)).toBe(17_999); // a rejected query is charged one unit
        for (let i = 0; i < 8; i++)
          await as('198.51.100.1', withIds(), { ids }).expect(200);
        const callsBefore = stub.calls.length;
        const denied = await as('198.51.100.1', withIds(), { ids }).expect(429);
        expect(problemDetailsSchema.parse(denied.body).code).toBe(
          'rate_limited',
        );
        expect(denied.headers['retry-after']).toBeDefined();
        expect(denied.headers['ratelimit-policy']).toContain(
          'bff.graphql.cost',
        );
        expect(stub.calls.length).toBe(callsBefore);
        await as('198.51.100.2', withIds(), { ids }).expect(200);
      } finally {
        await limited.close();
      }
    }, 60_000);
  });

  describe('US3 trusted documents, persisted GET, money, credentials', () => {
    let enforced: BffTestApp;
    beforeAll(async () => {
      enforced = await createBffApp({ upstreamUrl: stub.url });
    });
    afterAll(async () => enforced.close());
    beforeEach(() => enforced.app.get(BreakerRegistry).reset());

    const persisted = (
      hash: string,
      variables?: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      ...extra,
    });

    it('S48 AS-37: only allow-listed documents run when enforcement is on', async () => {
      const [p] = seedMany(1);
      const hash = hashOf('ProductScreen');
      const ok = (
        await post(persisted(hash, { id: p.id }), enforced).expect(200)
      ).body as GqlBody;
      expect(ok.errors).toBeUndefined();
      expect(ok.data!.product.id).toBe(p.id);

      const unknown = (
        await post(persisted('f'.repeat(64), { id: p.id }), enforced).expect(
          200,
        )
      ).body as GqlBody;
      expect(unknown.data).toBeUndefined();
      expect(codes(unknown)).toEqual(['PERSISTED_QUERY_NOT_FOUND']);

      const textOnly = await post({ query: '{ __typename }' }, enforced).expect(
        400,
      );
      expect(problemDetailsSchema.parse(textOnly.body).code).toBe(
        'persisted_query_required',
      );

      const text =
        '{ product(id: "00000000-0000-4000-8000-000000000000") { id } }';
      const mismatch = await post(
        persisted(sha256('something else'), undefined, { query: text }),
        enforced,
      ).expect(400);
      expect(problemDetailsSchema.parse(mismatch.body).code).toBe(
        'persisted_query_mismatch',
      );
      // a matching but unregistered document is not registered at run time either
      const matching = (
        await post(
          persisted(sha256(text), undefined, { query: text }),
          enforced,
        ).expect(200)
      ).body as GqlBody;
      expect(codes(matching)).toEqual(['PERSISTED_QUERY_NOT_FOUND']);
      const again = (await post(persisted(sha256(text)), enforced).expect(200))
        .body as GqlBody;
      expect(codes(again)).toEqual(['PERSISTED_QUERY_NOT_FOUND']);

      // local development accepts ad-hoc text
      const dev = (await gql('{ __typename }').expect(200)).body as GqlBody;
      expect(dev.data).toEqual({ __typename: 'Query' });
    });

    it('S48 AS-38: a persisted GET is shared-cacheable for 5 s only without credentials; raw text over GET is 400', async () => {
      const [p] = seedMany(1);
      const hash = hashOf('ProductScreen');
      const url = `/api/graphql?extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }))}&variables=${encodeURIComponent(JSON.stringify({ id: p.id }))}`;
      const anon = await enforced.http().get(url).expect(200);
      expect((anon.body as GqlBody).data!.product.id).toBe(p.id);
      expect(anon.headers['cache-control']).toBe('public, s-maxage=5');
      expect(String(anon.headers['vary'])).toMatch(
        /Authorization.*Cookie.*X-Anonymous-Id/i,
      );

      const bearer = await enforced
        .http()
        .get(url)
        .set('Authorization', 'Bearer t')
        .expect(200);
      expect(bearer.headers['cache-control']).toBe('private, no-store');
      const who = await signIn(enforced, stub);
      const cookie = await enforced
        .http()
        .get(url)
        .set('Cookie', who.cookie)
        .expect(200);
      expect(cookie.headers['cache-control']).toBe('private, no-store');

      const raw = await enforced
        .http()
        .get('/api/graphql?query=%7B__typename%7D')
        .expect(400);
      expect(problemDetailsSchema.parse(raw.body).code).toBe(
        'persisted_query_required',
      );
      const rawDev = await ctx
        .http()
        .get('/api/graphql?query=%7B__typename%7D')
        .expect(400);
      expect(problemDetailsSchema.parse(rawDev.body).code).toBe(
        'persisted_query_required',
      );
    });

    it('S48 AS-40: introspection is disabled when configured for production and costs no upstream call', async () => {
      const production = await createBffApp({
        upstreamUrl: stub.url,
        env: { BFF_LOCAL_DEV: 'true', BFF_INTROSPECTION: 'false' },
      });
      try {
        for (const q of [
          '{ __schema { types { name } } }',
          '{ __type(name: "Query") { name } }',
        ]) {
          const res = await gql(q, undefined, production).expect(400);
          expect(codes(res.body as GqlBody)).toEqual([
            'INTROSPECTION_DISABLED',
          ]);
        }
        expect(stub.calls).toHaveLength(0);
      } finally {
        await production.close();
      }
    });

    it('S48 AS-42: a bearer token goes only to identity fields; a cookie POST needs CSRF and an allowed origin', async () => {
      const [p] = seedMany(1);
      stub.respond('recommendations', { body: recommendationsFixture([]) });
      const q =
        'query($id: ID!) { chatUnread { items { channelId } } product(id: $id) { id shop { name } recommendations { id } } }';
      await post({ query: q, variables: { id: p.id } })
        .set('Authorization', 'Bearer only-for-chat')
        .expect(200);
      for (const call of stub.calls)
        expect(call.headers.authorization).toBe(
          call.route === 'chatUnread' ? 'Bearer only-for-chat' : undefined,
        );
      expect(stub.callsTo('chatUnread')).toHaveLength(1);

      stub.reset();
      stub.products.set(p.id, p);
      const who = await signIn(ctx, stub, { accessToken: 'session-token' });
      stub.calls.length = 0;
      const noCsrf = await post({ query: q, variables: { id: p.id } })
        .set('Cookie', who.cookie)
        .expect(403);
      expect(problemDetailsSchema.parse(noCsrf.body).code).toBe('csrf_invalid');
      const badOrigin = await post({ query: q, variables: { id: p.id } })
        .set({
          Cookie: who.cookie,
          'X-CSRF-Token': who.csrf,
          Origin: 'https://evil.example',
        })
        .expect(403);
      expect(problemDetailsSchema.parse(badOrigin.body).code).toBe(
        'origin_not_allowed',
      );
      expect(stub.calls).toHaveLength(0);

      const ok = await post({ query: q, variables: { id: p.id } })
        .set({
          Cookie: who.cookie,
          'X-CSRF-Token': who.csrf,
          Origin: ALLOWED_ORIGIN,
        })
        .expect(200);
      expect((ok.body as GqlBody).errors).toBeUndefined();
      expect(stub.callsTo('chatUnread')[0].headers.authorization).toBe(
        'Bearer session-token',
      );
      expect(
        stub.callsTo('productBatch')[0].headers.authorization,
      ).toBeUndefined();
    });

    it('S48 AS-60: the session cookie together with an Authorization header is 400 ambiguous_credentials', async () => {
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const res = await post({ query: '{ __typename }' })
        .set({ Cookie: who.cookie, Authorization: 'Bearer x' })
        .expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'ambiguous_credentials',
      );
      expect(stub.calls).toHaveLength(0);
    });

    it('S48 AS-62: an unknown or forged cookie is served as anonymous on GraphQL', async () => {
      const res = await post({
        query: '{ chatUnread { items { channelId } } }',
      }).set({
        Cookie: `${BFF_COOKIES.session}=${'E'.repeat(43)}`,
        'X-CSRF-Token': 'x',
        Origin: ALLOWED_ORIGIN,
      });
      // a cookie that names no session is no credential at all: anonymous, so identity fields are unauthenticated
      expect(res.status).toBe(403); // cookie-bearing POST without a valid CSRF token is refused first
      const get = await ctx
        .http()
        .get(
          '/api/graphql?extensions=' +
            encodeURIComponent(
              JSON.stringify({
                persistedQuery: { version: 1, sha256Hash: 'a'.repeat(64) },
              }),
            ),
        )
        .set('Cookie', `${BFF_COOKIES.session}=${'E'.repeat(43)}`)
        .expect(200);
      expect(codes(get.body as GqlBody)).toEqual(['PERSISTED_QUERY_NOT_FOUND']);
    });

    it('S48 AS-42: without credentials an identity field is UNAUTHENTICATED and makes no call', async () => {
      const body = (
        await gql('{ chatUnread { items { channelId } } }').expect(200)
      ).body as GqlBody;
      expect(body.data!.chatUnread).toBeNull();
      expect(codes(body)).toEqual(['UNAUTHENTICATED']);
      expect(stub.callsTo('chatUnread')).toHaveLength(0);
      stub.respond('chatUnread', { body: chatUnreadFixture() });
    });
  });

  describe('US3 schema', () => {
    const liveSchema = (): GraphQLSchema =>
      ctx.app.get(GraphQLSchemaHost).schema;

    it('S48 AS-41: money is a lossless MinorUnits string plus currency and no floating-point money field exists', async () => {
      const [p] = seedMany(1);
      const body = (
        await gql(
          'query($id: ID!) { product(id: $id) { priceMinor currency } }',
          { id: p.id },
        ).expect(200)
      ).body as GqlBody;
      expect(body.data!.product).toEqual({
        priceMinor: String(p.priceMinor),
        currency: p.currency,
      });
      const type = liveSchema().getType('Product');
      expect(isObjectType(type)).toBe(true);
      const fields = isObjectType(type) ? type.getFields() : {};
      expect(fields.priceMinor.type.toString()).toBe('MinorUnits!');
      for (const field of Object.values(fields))
        if (/price|amount|total|cost/i.test(field.name))
          expect(field.type.toString()).not.toMatch(/Float|Int/);
      expect(fields.price).toBeUndefined();
      expect(fields.stock).toBeUndefined();
    });

    it('S48 AS-41: the printed schema equals the committed snapshot; removing or retyping a field without @deprecated first is caught', () => {
      const printed = printSchema(liveSchema());
      if (!existsSync(SNAPSHOT) || process.env.UPDATE_SCHEMA_SNAPSHOT)
        writeFileSync(SNAPSHOT, printed);
      expect(printed).toBe(readFileSync(SNAPSHOT, 'utf8'));

      const committed = buildSchema(readFileSync(SNAPSHOT, 'utf8'));
      expect(breakingChanges(committed, committed)).toEqual([]);
      const without = buildSchema(
        readFileSync(SNAPSHOT, 'utf8').replace(/\n\s+rating: Float!/, ''),
      );
      expect(breakingChanges(committed, without)).toEqual([
        'Product.rating removed without @deprecated',
      ]);
      const retyped = buildSchema(
        readFileSync(SNAPSHOT, 'utf8').replace(
          /rating: Float!/,
          'rating: String!',
        ),
      );
      expect(breakingChanges(committed, retyped)).toEqual([
        'Product.rating retyped from Float! to String!',
      ]);
    });
  });
});

/** Fields removed or retyped between two schemas, unless the old field was already `@deprecated`. */
function breakingChanges(
  before: GraphQLSchema,
  after: GraphQLSchema,
): string[] {
  const problems: string[] = [];
  for (const [typeName, type] of Object.entries(before.getTypeMap())) {
    if (typeName.startsWith('__') || !isObjectType(type)) continue;
    const next = after.getType(typeName);
    for (const [fieldName, field] of Object.entries(type.getFields())) {
      const counterpart = isObjectType(next)
        ? next.getFields()[fieldName]
        : undefined;
      if (!counterpart) {
        if (!field.deprecationReason)
          problems.push(`${typeName}.${fieldName} removed without @deprecated`);
      } else if (counterpart.type.toString() !== field.type.toString())
        problems.push(
          `${typeName}.${fieldName} retyped from ${field.type} to ${counterpart.type}`,
        );
    }
  }
  return problems;
}
