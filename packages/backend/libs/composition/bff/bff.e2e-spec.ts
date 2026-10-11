import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  cartPageResponseSchema,
  orderPageResponseSchema,
  problemDetailsSchema,
  productPageResponseSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  BffTestApp,
  bffKeys,
  createBffApp,
  resetBffRedis,
} from './testing/app-factory';
import { cartFixture, orderFixture, paymentFixture } from './testing/fixtures';
import { seedProduct, signIn, waitFor } from './testing/helpers';
import { StubUpstream, TripwireServer } from './testing/stub-upstream';
import { BreakerRegistry } from './upstream/breaker-registry';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const ANON = 'anon_12345678';
const FORGED = {
  'x-user-id': 'someone-else',
  'x-user-role': 'ADMIN',
  'x-tenant-id': 'tenant-1',
  'x-shop-id': 'shop-1',
  'x-forwarded-host': 'evil.example',
};

describe('BFF product page composition', () => {
  let stub: StubUpstream;
  let tripwire: TripwireServer;
  let ctx: BffTestApp;

  beforeAll(async () => {
    stub = await StubUpstream.start();
    tripwire = await TripwireServer.start();
    ctx = await createBffApp({ upstreamUrl: stub.url });
  });

  afterAll(async () => {
    await ctx.close();
    await stub.close();
    await tripwire.close();
  });

  beforeEach(async () => {
    stub.reset();
    tripwire.requests.length = 0;
    ctx.clock.set(T0);
    ctx.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
  });

  const page = (id: string, query = '') =>
    ctx.http().get(`/api/bff/product-page/${id}${query}`);

  /**
   * After a required failure nothing may keep working: a slow call that had already left was cut (the stub saw the
   * connection close), and one that had not left yet was never sent.
   */
  const expectNoWorkLeft = async (
    slowRoutes: Parameters<StubUpstream['callsTo']>[0][],
  ) => {
    await waitFor(
      () => stub.inFlight === 0,
      2_000,
      'outstanding calls to stop',
    );
    for (const route of slowRoutes)
      for (const call of stub.callsTo(route)) expect(call.aborted).toBe(true);
  };
  const parsePage = (body: unknown) => productPageResponseSchema.parse(body);
  const parseProblem = (body: unknown) => problemDetailsSchema.parse(body);

  describe('US1 one request renders the product page', () => {
    it('S48 AS-01: anonymous visitor gets the product and every applicable section, bodies unchanged', async () => {
      const product = seedProduct(stub);
      const other = seedProduct(stub);
      void other;
      const res = await page(product.id)
        .set('X-Anonymous-Id', ANON)
        .expect(200);

      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = parsePage(res.body);
      expect(body.product).toEqual(product);
      const response = (route: Parameters<StubUpstream['callsTo']>[0]) =>
        stub.callsTo(route)[0].responseBody;
      expect(body.shop).toEqual((response('shopBatch') as unknown[])[0]);
      expect(body.recommendations).toEqual(response('recommendations'));
      expect(body.trending).toEqual(response('trending'));
      expect(body.flags).toEqual(response('flags'));
      expect(body.discussions).toEqual(response('discussions'));
      expect(body.videos).toEqual(response('videos'));
      expect(body.gallery).toEqual(response('gallery'));
      expect(body.flashSale).toEqual((response('flashSale') as unknown[])[0]);
      expect(body.auction).toEqual((response('auction') as unknown[])[0]);
      expect(body.chatUnread).toBeNull();
      expect(body.pickup).toBeNull();
      expect(body.errors).toEqual([]);
      // the calls carry the documented parameters
      expect(stub.callsTo('recommendations')[0].query).toEqual({ limit: '8' });
      expect(stub.callsTo('trending')[0].query).toEqual({
        category: product.category,
      });
      expect(stub.callsTo('discussions')[0].query).toEqual({
        sort: 'hot',
        limit: '3',
      });
      expect(stub.callsTo('flashSale')[0].query).toEqual({
        productIds: product.id,
      });
      expect(stub.callsTo('auction')[0].query).toEqual({
        productIds: product.id,
      });
      expect(stub.callsTo('shopBatch')[0].query).toEqual({
        ids: product.shopId,
      });
    });

    it('S48 AS-02: anonymous visitor: chat is skipped without an error, nobody sees a token, flags see the anonymous id', async () => {
      const product = seedProduct(stub);
      const res = await page(product.id)
        .set('X-Anonymous-Id', ANON)
        .expect(200);
      const body = parsePage(res.body);
      expect(body.chatUnread).toBeNull();
      expect(
        body.errors.find((e) => e.section === 'chatUnread'),
      ).toBeUndefined();
      expect(stub.callsTo('chatUnread')).toHaveLength(0);
      for (const call of stub.calls)
        expect(call.headers.authorization).toBeUndefined();
      expect(stub.callsTo('flags')[0].headers['x-anonymous-id']).toBe(ANON);
    });

    it('S48 AS-03: signed-in browser session: the access token reaches flags and chat only, never a Cookie, chat page unchanged', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, { accessToken: 'access-of-A' });
      stub.calls.length = 0;
      const res = await page(product.id).set('Cookie', who.cookie).expect(200);
      const body = parsePage(res.body);
      expect(body.chatUnread).toEqual(
        stub.callsTo('chatUnread')[0].responseBody,
      );
      expect(body.chatUnread?.nextCursor).toBe('cursor-2');
      for (const call of stub.calls) {
        expect(call.headers.cookie).toBeUndefined();
        const expected = ['flags', 'chatUnread'].includes(call.route)
          ? 'Bearer access-of-A'
          : undefined;
        expect(call.headers.authorization).toBe(expected);
      }
      expect(JSON.stringify(res.body)).not.toContain('access-of-A');
    });

    it('S48 AS-04: a hidden shop gives shop null with no error entry', async () => {
      const product = seedProduct(stub);
      stub.hiddenShops.add(product.shopId);
      const res = await page(product.id).expect(200);
      const body = parsePage(res.body);
      expect(body.shop).toBeNull();
      expect(body.errors).toEqual([]);
      expect(stub.callsTo('shopBatch')).toHaveLength(1);
    });

    it('S48 AS-05: pickup needs a location: skipped without, called once with, 400 for bad combinations', async () => {
      const product = seedProduct(stub);
      const without = parsePage((await page(product.id).expect(200)).body);
      expect(without.pickup).toBeNull();
      expect(without.errors).toEqual([]);
      expect(stub.callsTo('pickup')).toHaveLength(0);

      const withLocation = parsePage(
        (await page(product.id, '?lat=50.45&lng=30.52&radiusKm=10').expect(200))
          .body,
      );
      expect(stub.callsTo('pickup')).toHaveLength(1);
      expect(stub.callsTo('pickup')[0].query).toEqual({
        lat: '50.45',
        lng: '30.52',
        radiusKm: '10',
        productId: product.id,
        limit: '5',
      });
      expect(withLocation.pickup).toEqual(
        stub.callsTo('pickup')[0].responseBody,
      );

      for (const bad of [
        '?lat=91&lng=30',
        '?lat=50',
        '?lng=30',
        '?lat=50&lng=30&radiusKm=0',
        '?lat=50&lng=30&radiusKm=101',
        '?lat=x&lng=30',
        '?unknown=1',
      ]) {
        stub.calls.length = 0;
        const res = await page(product.id, bad).expect(400);
        expect(parseProblem(res.body).code).toBe('validation_failed');
        expect(stub.calls).toHaveLength(0);
      }
    });

    it('S48 AS-06: independent sections start with the product, shop and trending after it, total below the sum', async () => {
      const product = seedProduct(stub);
      for (const route of [
        'product',
        'shopBatch',
        'recommendations',
        'trending',
        'flags',
        'discussions',
        'videos',
        'gallery',
        'flashSale',
        'auction',
      ] as const)
        stub.respond(route, (call) => {
          void call;
          return { delayMs: 300 };
        });
      const started = Date.now();
      const res = await page(product.id)
        .set('X-Anonymous-Id', ANON)
        .expect(200);
      const elapsed = Date.now() - started;
      parsePage(res.body);
      const productCall = stub.callsTo('product')[0];
      for (const route of [
        'recommendations',
        'flags',
        'discussions',
        'videos',
        'gallery',
        'flashSale',
        'auction',
      ] as const)
        expect(
          Math.abs(stub.callsTo(route)[0].startedAt - productCall.startedAt),
        ).toBeLessThan(80);
      for (const route of ['shopBatch', 'trending'] as const)
        expect(stub.callsTo(route)[0].startedAt).toBeGreaterThanOrEqual(
          productCall.endedAt! - 5,
        );
      expect(elapsed).toBeLessThan(300 + 300 + 250); // product + longest dependent + tolerance, far below 9 × 300
    });

    it('S48 AS-08: a non-UUID id is 400 validation_failed and nothing is called', async () => {
      const res = await page('not-a-uuid').expect(400);
      expect(parseProblem(res.body).code).toBe('validation_failed');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stub.calls).toHaveLength(0);
    });
  });

  describe('US1 required-part failures', () => {
    it('S48 AS-07: an unknown product is 404 not_found and outstanding calls are aborted', async () => {
      const id = randomUUID();
      stub.respond('recommendations', { delayMs: 3_000 });
      stub.respond('discussions', { delayMs: 3_000 });
      const res = await page(id).expect(404);
      expect(parseProblem(res.body).code).toBe('not_found');
      await expectNoWorkLeft(['recommendations', 'discussions']);
      expect(stub.callsTo('shopBatch')).toHaveLength(0);
    });

    it('S48 AS-09: the product call is retried once on 503 and not on 400/404', async () => {
      const product = seedProduct(stub);
      stub.respondInOrder('product', [{ status: 503, body: {} }]);
      const ok = await page(product.id).expect(200);
      parsePage(ok.body);
      expect(stub.callsTo('product')).toHaveLength(2);

      stub.reset();
      const again = seedProduct(stub);
      stub.respond('product', {
        status: 503,
        body: { detail: 'secret upstream message' },
        headers: { 'retry-after': '1' },
      });
      const down = await page(again.id).expect(503);
      const problem = parseProblem(down.body);
      expect(problem.code).toBe('upstream_unavailable');
      expect(problem.detail).not.toContain('secret');
      expect(down.headers['retry-after']).toBeDefined();
      expect(stub.callsTo('product')).toHaveLength(2);

      for (const status of [400, 404]) {
        stub.reset();
        stub.respond('product', { status, body: {} });
        await page(randomUUID()).expect(status === 404 ? 404 : 502);
        expect(stub.callsTo('product')).toHaveLength(1);
      }
    });

    it('S48 AS-10: an invalid product body is 502 upstream_invalid with a generic detail and a log line with the request id', async () => {
      const product = seedProduct(stub);
      stub.respond('product', {
        body: { id: product.id, secretField: 'leak-me' },
      });
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const res = await page(product.id).expect(502);
        const problem = parseProblem(res.body);
        expect(problem.code).toBe('upstream_invalid');
        expect(JSON.stringify(res.body)).not.toMatch(
          /secretField|leak-me|viewCount/,
        );
        const requestId = String(res.headers['x-request-id']);
        expect(
          warn.mock.calls.some(
            (c) =>
              String(c[0]).includes(requestId) &&
              !String(c[0]).includes('leak-me'),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('S48 AS-11: an upstream 401 on a credentialed call is a 401 invalid_token and the other calls are aborted', async () => {
      const product = seedProduct(stub);
      stub.respond('chatUnread', { status: 401, body: {} });
      stub.respond('recommendations', { delayMs: 3_000 });
      const res = await page(product.id)
        .set('Authorization', 'Bearer some-native-token')
        .expect(401);
      expect(parseProblem(res.body).code).toBe('invalid_token');
      await expectNoWorkLeft(['recommendations']);
    });
  });

  describe('US1 identity and header hygiene', () => {
    it('S48 AS-21: client identity headers never reach an upstream; a valid anonymous id reaches flags only; redirects are not followed', async () => {
      const product = seedProduct(stub);
      const traceparent =
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const requestId = 'req-abcdef123456';
      const res = await page(product.id)
        .set(FORGED)
        .set('Cookie', 'tracking=1; other=2')
        .set('X-Anonymous-Id', 'a b')
        .set('traceparent', traceparent)
        .set('X-Request-Id', requestId)
        .expect(200);
      expect(res.headers['x-request-id']).toBe(requestId);
      for (const call of stub.calls) {
        for (const name of [
          ...Object.keys(FORGED),
          'cookie',
          'x-anonymous-id',
          'authorization',
        ])
          expect(call.headers[name]).toBeUndefined();
        expect(call.headers['x-request-id']).toBe(requestId);
        expect(call.headers.traceparent).toContain(
          '0af7651916cd43dd8448eb211c80319c',
        );
      }

      stub.reset();
      stub.products.set(product.id, product);
      await page(product.id)
        .set('X-Anonymous-Id', ANON)
        .set('Authorization', 'Bearer native-token')
        .expect(200);
      for (const call of stub.calls) {
        const sees = ['flags', 'chatUnread'].includes(call.route);
        expect(call.headers.authorization).toBe(
          sees ? 'Bearer native-token' : undefined,
        );
        expect(call.headers['x-anonymous-id']).toBe(
          call.route === 'flags' ? ANON : undefined,
        );
      }

      stub.reset();
      stub.products.set(product.id, product);
      stub.respond('flags', { redirect: `${tripwire.url}/steal` });
      const redirected = await page(product.id)
        .set('Authorization', 'Bearer native-token')
        .expect(200);
      const body = parsePage(redirected.body);
      expect(body.flags).toBeNull();
      expect(body.errors).toContainEqual({
        section: 'flags',
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
      });
      expect(tripwire.requests).toHaveLength(0);
    });

    it('S48 AS-22: the 301st request of a principal in a minute is 429 with structured rate-limit headers; another principal is not affected', async () => {
      const limited = await createBffApp({
        upstreamUrl: stub.url,
        env: { TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1' },
      });
      try {
        await resetBffRedis(limited.redis);
        const as = (ip: string, id = 'not-a-uuid') =>
          limited
            .http()
            .get(`/api/bff/product-page/${id}`)
            .set('X-Forwarded-For', ip);
        // the interceptor counts before the pipe: 300 cheap invalid-id requests spend the budget
        for (let i = 0; i < 300; i++) await as('198.51.100.7').expect(400);
        const denied = await as('198.51.100.7').expect(429);
        expect(parseProblem(denied.body).code).toBe('rate_limited');
        expect(denied.headers['retry-after']).toBeDefined();
        expect(denied.headers['ratelimit']).toBeDefined();
        expect(denied.headers['ratelimit-policy']).toContain(
          'bff.product-page.principal',
        );
        // the legacy names, assembled so the S50 grep gate (legacy-rate-limit-headers.spec.ts) stays meaningful
        for (const legacy of [
          ['ratelimit', 'limit'],
          ['ratelimit', 'remaining'],
          ['ratelimit', 'reset'],
          ['x', 'ratelimit', 'limit'],
        ].map((parts) => parts.join('-')))
          expect(denied.headers[legacy]).toBeUndefined();
        expect(stub.calls).toHaveLength(0);
        await as('198.51.100.8').expect(400); // another principal
        expect(
          (await bffKeys(limited.redis, 'rl:*bff.product-page.principal*'))
            .length,
        ).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    }, 120_000);

    it('S48 AS-24: 30 sequential pages open at most 10 connections per upstream host', async () => {
      const fresh = await createBffApp({ upstreamUrl: stub.url });
      try {
        const product = seedProduct(stub);
        const before = stub.connections;
        for (let i = 0; i < 30; i++)
          await fresh
            .http()
            .get(`/api/bff/product-page/${product.id}`)
            .set('X-Anonymous-Id', ANON)
            .expect(200);
        expect(stub.callsTo('product')).toHaveLength(30);
        expect(stub.connections - before).toBeLessThanOrEqual(10);
      } finally {
        await fresh.close();
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('US2 a slow or broken section never breaks the page', () => {
    type Section =
      | 'shop'
      | 'recommendations'
      | 'trending'
      | 'flags'
      | 'chatUnread'
      | 'discussions'
      | 'videos'
      | 'gallery'
      | 'pickup'
      | 'flashSale'
      | 'auction';
    const ROUTE_OF: Record<Section, Parameters<StubUpstream['respond']>[0]> = {
      shop: 'shopBatch',
      recommendations: 'recommendations',
      trending: 'trending',
      flags: 'flags',
      chatUnread: 'chatUnread',
      discussions: 'discussions',
      videos: 'videos',
      gallery: 'gallery',
      pickup: 'pickup',
      flashSale: 'flashSale',
      auction: 'auction',
    };
    const SECTIONS = Object.keys(ROUTE_OF) as Section[];
    /** A request that makes every one of the ten optional sections apply. */
    const fullPage = (id: string) =>
      page(id, '?lat=50.45&lng=30.52&radiusKm=10').set(
        'Authorization',
        'Bearer native-token',
      );
    const FAILURES = [
      ['timeout', { body: {}, delayMs: 1_000 }, 'UPSTREAM_TIMEOUT', true],
      [
        '503',
        { status: 503, body: { detail: 'secret internal message' } },
        'UPSTREAM_UNAVAILABLE',
        true,
      ],
      ['404', { status: 404, body: {} }, 'UPSTREAM_NOT_FOUND', false],
      ['429', { status: 429, body: {} }, 'UPSTREAM_RATE_LIMITED', true],
      ['connection reset', { reset: true }, 'UPSTREAM_UNAVAILABLE', true],
      [
        'invalid body',
        { body: { not: 'the contract' } },
        'UPSTREAM_INVALID',
        false,
      ],
    ] as const;

    it('W02 B-2: the gallery section is present, anonymous-safe, and forwards the upstream body unchanged', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, { accessToken: 'access-of-A' });
      stub.calls.length = 0;
      const res = await page(product.id).set('Cookie', who.cookie).expect(200);
      const body = parsePage(res.body);
      const call = stub.callsTo('gallery')[0];
      expect(body.gallery).toEqual(call.responseBody);
      expect(body.gallery?.items).toHaveLength(1);
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers['x-anonymous-id']).toBeUndefined();
      expect(call.path).toBe(`/api/products/${product.id}/gallery`);
    });

    it('W02 B-2: a failing gallery gives gallery null plus one errors entry; the rest is unchanged', async () => {
      const product = seedProduct(stub);
      stub.respond('gallery', { status: 503, body: {} });
      const body = parsePage((await page(product.id).expect(200)).body);
      expect(body.gallery).toBeNull();
      expect(body.errors).toEqual([
        { section: 'gallery', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ]);
      expect(body.shop).not.toBeNull();
      expect(body.videos).not.toBeNull();
    });

    it('W02 B-2: a gallery slower than its 300 ms budget is null with UPSTREAM_TIMEOUT and is aborted', async () => {
      const product = seedProduct(stub);
      stub.respond('gallery', { delayMs: 500 });
      const started = Date.now();
      const body = parsePage((await page(product.id).expect(200)).body);
      expect(Date.now() - started).toBeLessThan(300 + 150);
      expect(body.gallery).toBeNull();
      expect(body.errors).toEqual([
        { section: 'gallery', code: 'UPSTREAM_TIMEOUT', retryable: true },
      ]);
      await waitFor(
        () => stub.callsTo('gallery')[0].aborted,
        1_000,
        'gallery abort',
      );
    });

    it('S48 AS-12: a recommendations call slower than its 300 ms budget degrades to null with UPSTREAM_TIMEOUT and is aborted', async () => {
      const product = seedProduct(stub);
      stub.respond('recommendations', { delayMs: 500 });
      const started = Date.now();
      const res = await page(product.id)
        .set('X-Anonymous-Id', ANON)
        .expect(200);
      const elapsed = Date.now() - started;
      const body = parsePage(res.body);
      expect(body.recommendations).toBeNull();
      expect(body.errors).toEqual([
        {
          section: 'recommendations',
          code: 'UPSTREAM_TIMEOUT',
          retryable: true,
        },
      ]);
      expect(body.shop).not.toBeNull();
      expect(body.trending).not.toBeNull();
      expect(body.flags).not.toBeNull();
      expect(elapsed).toBeLessThan(300 + 150);
      await waitFor(
        () => stub.callsTo('recommendations')[0].aborted,
        1_000,
        'recommendations abort',
      );
    });

    it.each(
      SECTIONS.flatMap((section) =>
        FAILURES.map(
          ([failure, behavior, code, retryable]) =>
            [section, failure, behavior, code, retryable] as const,
        ),
      ),
    )(
      'S48 AS-13: %s answering %s is null with one closed-set error entry',
      async (section, _failure, behavior, code, retryable) => {
        const product = seedProduct(stub);
        stub.respond(ROUTE_OF[section], behavior);
        const res = await fullPage(product.id).expect(200);
        const body = parsePage(res.body);
        expect(body[section]).toBeNull();
        expect(body.errors).toEqual([{ section, code, retryable }]);
        expect(JSON.stringify(res.body)).not.toMatch(
          /secret internal|127\.0\.0\.1|http:/,
        );
        expect(body.product).toEqual(product);
      },
      20_000,
    );

    it.each([
      ['timeout', FAILURES[0]],
      ['503', FAILURES[1]],
      ['404', FAILURES[2]],
      ['invalid body', FAILURES[5]],
    ] as const)(
      'S34 A25: recommendations %s gives null and the matching error; the rest of the page is intact',
      async (_name, [, behavior, code, retryable]) => {
        const product = seedProduct(stub);
        stub.respond('recommendations', behavior);
        const body = parsePage((await page(product.id).expect(200)).body);
        expect(body.recommendations).toBeNull();
        expect(body.errors).toEqual([
          { section: 'recommendations', code, retryable },
        ]);
        expect(body.trending).not.toBeNull();
      },
    );

    it('S34 A25: a valid recommendations envelope is forwarded unchanged, including empty items', async () => {
      const product = seedProduct(stub);
      const empty = { type: 'bought-together', items: [] };
      stub.respond('recommendations', { body: empty });
      const body = parsePage((await page(product.id).expect(200)).body);
      expect(body.recommendations).toEqual(empty);
      expect(body.errors).toEqual([]);
    });

    it('S48 AS-14: one failing section leaves the others byte-identical; all eleven failing is still 200', async () => {
      const product = seedProduct(stub);
      const healthy = (await fullPage(product.id).expect(200)).body;
      stub.respond('recommendations', { status: 503, body: {} });
      const degraded = (await fullPage(product.id).expect(200)).body;
      for (const key of Object.keys(healthy).filter(
        (k) => k !== 'recommendations' && k !== 'errors',
      ))
        expect(JSON.stringify(degraded[key])).toBe(
          JSON.stringify(healthy[key]),
        );
      expect(degraded.recommendations).toBeNull();

      for (const section of SECTIONS)
        stub.respond(ROUTE_OF[section], { status: 503, body: {} });
      const allDown = parsePage((await fullPage(product.id).expect(200)).body);
      expect(allDown.product).toEqual(product);
      for (const section of SECTIONS) expect(allDown[section]).toBeNull();
      expect(allDown.errors).toHaveLength(11);
    });

    it.each([
      [
        'recommendations',
        'recommendations',
        { type: 'bought-together', items: [] },
      ],
      [
        'trending',
        'trending',
        {
          category: 'audio',
          windowMinutes: 60,
          generatedAt: '2026-01-01T12:00:00.000Z',
          items: [],
        },
      ],
    ] as const)(
      'S48 AS-15: %s is forwarded unchanged (also with empty items); slow, 503, 429 or an invalid body give null and the matching error',
      async (section, route, empty) => {
        const product = seedProduct(stub);
        const ok = parsePage((await page(product.id).expect(200)).body);
        expect(ok[section]).toEqual(stub.callsTo(route)[0].responseBody);
        stub.respond(route, { body: empty });
        expect(
          parsePage((await page(product.id).expect(200)).body)[section],
        ).toEqual(empty);
        for (const [, behavior, code, retryable] of [
          FAILURES[0],
          FAILURES[1],
          FAILURES[3],
          FAILURES[5],
        ]) {
          stub.respond(route, behavior);
          const body = parsePage((await page(product.id).expect(200)).body);
          expect(body[section]).toBeNull();
          expect(body.errors).toEqual([{ section, code, retryable }]);
          expect(body.product).toEqual(product);
        }
      },
      20_000,
    );

    it('S35 AS-42: trending is an optional 200 ms section: unchanged on success (also empty), absent with its error otherwise', async () => {
      const product = seedProduct(stub);
      const ok = parsePage((await page(product.id).expect(200)).body);
      expect(ok.trending).toEqual(stub.callsTo('trending')[0].responseBody);
      expect(ok.errors).toEqual([]);

      stub.respond('trending', {
        body: {
          category: product.category,
          windowMinutes: 60,
          generatedAt: '2026-01-01T12:00:00.000Z',
          items: [],
        },
      });
      const empty = parsePage((await page(product.id).expect(200)).body);
      expect(empty.trending?.items).toEqual([]);
      expect(empty.errors).toEqual([]);

      for (const [, behavior, code, retryable] of [
        FAILURES[0],
        FAILURES[1],
        FAILURES[3],
        FAILURES[5],
      ]) {
        stub.respond('trending', behavior);
        const started = Date.now();
        const res = parsePage((await page(product.id).expect(200)).body);
        expect(Date.now() - started).toBeLessThan(200 + 250);
        expect(res.trending).toBeNull();
        expect(res.errors).toEqual([{ section: 'trending', code, retryable }]);
        expect(res.shop).not.toBeNull();
      }
    });

    it('S48 AS-16: a dependent section gets only the time left before the 1,000 ms deadline; a product beyond its budget is 503', async () => {
      const product = seedProduct(stub);
      stub.respond('product', { delayMs: 700 });
      stub.respond('shopBatch', { delayMs: 600 });
      const started = Date.now();
      const res = await page(product.id).expect(200);
      expect(Date.now() - started).toBeLessThanOrEqual(1_100);
      const body = parsePage(res.body);
      expect(body.shop).toBeNull();
      expect(body.errors).toContainEqual({
        section: 'shop',
        code: 'BUDGET_EXCEEDED',
        retryable: true,
      });

      stub.respond('product', { delayMs: 1_200 });
      const slow = await page(product.id).expect(503);
      expect(parseProblem(slow.body).code).toBe('upstream_unavailable');
    });

    it('S48 AS-17: five consecutive failures open the breaker; one probe after 10 s closes or re-opens it', async () => {
      const product = seedProduct(stub);
      stub.respond('recommendations', { status: 503, body: {} });
      for (let i = 0; i < 5; i++) {
        const body = parsePage((await page(product.id).expect(200)).body);
        expect(body.errors).toEqual([
          {
            section: 'recommendations',
            code: 'UPSTREAM_UNAVAILABLE',
            retryable: true,
          },
        ]);
      }
      expect(stub.callsTo('recommendations')).toHaveLength(5);

      const skipped = parsePage((await page(product.id).expect(200)).body);
      expect(skipped.errors).toEqual([
        { section: 'recommendations', code: 'CIRCUIT_OPEN', retryable: true },
      ]);
      expect(stub.callsTo('recommendations')).toHaveLength(5); // not called
      expect(skipped.flags).not.toBeNull(); // another upstream's breaker is untouched

      ctx.clock.advance(10_000);
      const probe = parsePage((await page(product.id).expect(200)).body);
      expect(stub.callsTo('recommendations')).toHaveLength(6); // exactly one probe
      expect(probe.errors).toEqual([
        {
          section: 'recommendations',
          code: 'UPSTREAM_UNAVAILABLE',
          retryable: true,
        },
      ]);
      const reopened = parsePage((await page(product.id).expect(200)).body);
      expect(reopened.errors[0].code).toBe('CIRCUIT_OPEN');
      expect(stub.callsTo('recommendations')).toHaveLength(6);

      ctx.clock.advance(10_000);
      stub.respond('recommendations', {}); // the upstream recovered
      const recovered = parsePage((await page(product.id).expect(200)).body);
      expect(recovered.errors).toEqual([]);
      expect(stub.callsTo('recommendations')).toHaveLength(7);
      await page(product.id).expect(200);
      expect(stub.callsTo('recommendations')).toHaveLength(8); // closed: called normally
    });

    describe('S48 AS-18 bulkhead', () => {
      // 100 pages in one process outlast the normal 300 ms section budget: this instance waits long enough to hold them
      let patient: BffTestApp;
      beforeAll(async () => {
        patient = await createBffApp({
          upstreamUrl: stub.url,
          env: {
            BFF_BUDGET_VIDEOS_MS: '20000',
            BFF_BUDGET_PRODUCT_MS: '20000',
            BFF_PAGE_DEADLINE_MS: '20000',
          },
        });
      });
      afterAll(async () => patient.close());
      beforeEach(async () => {
        patient.app.get(BreakerRegistry).reset();
        await resetBffRedis(patient.redis);
      });
      const patientPage = (id: string) =>
        patient.http().get(`/api/bff/product-page/${id}`);

      it('S48 AS-18: at 100 calls in flight to an upstream the next optional section is UPSTREAM_OVERLOADED', async () => {
        const hold = stub.hold('videos');
        const held = Array.from({ length: 100 }, () =>
          patientPage(seedProduct(stub).id).then((r) => r),
        );
        await waitFor(
          () => stub.callsTo('videos').length === 100,
          15_000,
          '100 held calls',
        );
        const body = parsePage(
          (await patientPage(seedProduct(stub).id).expect(200)).body,
        );
        expect(body.videos).toBeNull();
        expect(body.errors).toContainEqual({
          section: 'videos',
          code: 'UPSTREAM_OVERLOADED',
          retryable: true,
        });
        expect(stub.callsTo('videos')).toHaveLength(100);
        hold.release();
        for (const r of await Promise.all(held)) expect(r.status).toBe(200);
      }, 60_000);

      it('S48 AS-18: the product call without a slot is 503 overloaded with Retry-After 1', async () => {
        const hold = stub.hold('product');
        const held = Array.from({ length: 100 }, () =>
          patientPage(randomUUID()).then((r) => r),
        );
        await waitFor(
          () => stub.callsTo('product').length === 100,
          15_000,
          '100 held product calls',
        );
        const res = await patientPage(randomUUID()).expect(503);
        expect(parseProblem(res.body).code).toBe('overloaded');
        expect(res.headers['retry-after']).toBe('1');
        expect(stub.callsTo('product')).toHaveLength(100);
        hold.release();
        await Promise.all(held);
      }, 60_000);
    });

    it('S48 AS-18: a single page request never has more than 12 upstream calls in flight', async () => {
      const product = seedProduct(stub);
      for (const route of [
        'shopBatch',
        'recommendations',
        'trending',
        'flags',
        'chatUnread',
        'discussions',
        'videos',
        'gallery',
        'pickup',
        'flashSale',
        'auction',
      ] as const)
        stub.respond(route, { delayMs: 100 });
      await fullPage(product.id).expect(200);
      expect(stub.maxInFlight).toBeLessThanOrEqual(12);
      expect(stub.maxInFlight).toBeGreaterThan(5);
    });

    describe('S48 AS-19 shared cache', () => {
      it('S48 AS-19: a public s-maxage answer is served from the cache for visitors until it expires', async () => {
        const product = seedProduct(stub);
        stub.respond('recommendations', {
          headers: { 'cache-control': 'public, s-maxage=5' },
        });
        const first = parsePage(
          (
            await page(product.id)
              .set('X-Anonymous-Id', 'visitor_aaaaaaaa')
              .expect(200)
          ).body,
        );
        ctx.clock.advance(2_000);
        const second = parsePage(
          (
            await page(product.id)
              .set('X-Anonymous-Id', 'visitor_bbbbbbbb')
              .expect(200)
          ).body,
        );
        expect(stub.callsTo('recommendations')).toHaveLength(1);
        expect(second.recommendations).toEqual(first.recommendations);
        expect(
          (await bffKeys(ctx.redis, 'bff:cache:recommendations:*')).length,
        ).toBe(1);
        ctx.clock.advance(4_000); // 6 s after the first
        await page(product.id).expect(200);
        expect(stub.callsTo('recommendations')).toHaveLength(2);
      });

      it.each([
        ['private', 'private, s-maxage=5'],
        ['no-store', 'no-store'],
        ['no header', undefined],
      ])(
        'S48 AS-19: an answer marked %s is never cached',
        async (_name, header) => {
          const product = seedProduct(stub);
          stub.respond(
            'recommendations',
            header ? { headers: { 'cache-control': header } } : {},
          );
          await page(product.id).expect(200);
          await page(product.id).expect(200);
          expect(stub.callsTo('recommendations')).toHaveLength(2);
          expect(
            await bffKeys(ctx.redis, 'bff:cache:recommendations:*'),
          ).toHaveLength(0);
        },
      );

      it('S48 AS-19: personal sections are never cached and one caller never sees another caller’s answer', async () => {
        const product = seedProduct(stub);
        stub.respond('flags', (call) => ({
          body: {
            flags: { who: String(call.headers.authorization ?? 'anonymous') },
          },
          headers: { 'cache-control': 'public, s-maxage=5' },
        }));
        const asA = parsePage(
          (
            await page(product.id)
              .set('Authorization', 'Bearer token-A')
              .expect(200)
          ).body,
        );
        const asB = parsePage(
          (
            await page(product.id)
              .set('Authorization', 'Bearer token-B')
              .expect(200)
          ).body,
        );
        const anon = parsePage((await page(product.id).expect(200)).body);
        expect(asA.flags?.flags).toEqual({ who: 'Bearer token-A' });
        expect(asB.flags?.flags).toEqual({ who: 'Bearer token-B' });
        expect(anon.flags?.flags).toEqual({ who: 'anonymous' });
        expect(stub.callsTo('flags')).toHaveLength(3);
        expect(await bffKeys(ctx.redis, 'bff:cache:flags:*')).toHaveLength(0);
        expect(await bffKeys(ctx.redis, 'bff:cache:chat*')).toHaveLength(0);
      });

      it('S48 AS-19: an entry never outlives 30 s, whatever the upstream header says', async () => {
        const product = seedProduct(stub);
        stub.respond('recommendations', {
          headers: { 'cache-control': 'public, s-maxage=3600' },
        });
        await page(product.id).expect(200);
        ctx.clock.advance(29_000);
        await page(product.id).expect(200);
        expect(stub.callsTo('recommendations')).toHaveLength(1);
        ctx.clock.advance(2_000);
        await page(product.id).expect(200);
        expect(stub.callsTo('recommendations')).toHaveLength(2);
      });
    });

    it('S48 AS-20: 50 simultaneous visitors cause one call per public upstream and one per visitor for personal sections', async () => {
      const product = seedProduct(stub);
      for (const route of [
        'product',
        'shopBatch',
        'recommendations',
        'trending',
        'discussions',
        'videos',
        'gallery',
        'flashSale',
        'auction',
      ] as const)
        stub.respond(route, { delayMs: 150 });
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          page(product.id)
            .set('Authorization', `Bearer visitor-${i}`)
            .then((r) => r),
        ),
      );
      for (const r of results) expect(r.status).toBe(200);
      for (const route of [
        'product',
        'shopBatch',
        'recommendations',
        'trending',
        'discussions',
        'videos',
        'gallery',
        'flashSale',
        'auction',
      ] as const)
        expect(stub.callsTo(route)).toHaveLength(1);
      expect(stub.callsTo('flags')).toHaveLength(50);
      expect(stub.callsTo('chatUnread')).toHaveLength(50);
    }, 30_000);
  });

  describe('US2 observability', () => {
    it('S48 AS-23: every outcome is counted, durations recorded, and the log line carries the request id and no secret', async () => {
      const product = seedProduct(stub);
      stub.respond('recommendations', { status: 503, body: {} });
      const before = (section: string, outcome: string) =>
        MetricsRegistry.value('bff_section_outcomes_total', {
          section,
          outcome,
        }) ?? 0;
      const base = {
        ok: before('flags', 'ok'),
        failed: before('recommendations', 'UPSTREAM_UNAVAILABLE'),
        skipped: before('chatUnread', 'skipped'),
      };
      const durations =
        MetricsRegistry.histogramValue('bff_section_duration_seconds', {
          section: 'product',
        })?.count ?? 0;
      const log = jest.spyOn(Logger.prototype, 'log');
      try {
        const res = await page(product.id)
          .set('X-Anonymous-Id', ANON)
          .set('Cookie', 'unrelated=1')
          .expect(200);
        const requestId = String(res.headers['x-request-id']);
        expect(before('flags', 'ok')).toBe(base.ok + 1);
        expect(before('recommendations', 'UPSTREAM_UNAVAILABLE')).toBe(
          base.failed + 1,
        );
        expect(before('chatUnread', 'skipped')).toBe(base.skipped + 1);
        expect(
          MetricsRegistry.histogramValue('bff_section_duration_seconds', {
            section: 'product',
          })?.count,
        ).toBe(durations + 1);
        const lines = log.mock.calls
          .map((c) => String(c[0]))
          .filter((l) => l.includes('"event":"product_page"'));
        expect(lines).toHaveLength(1);
        const line = JSON.parse(lines[0]);
        expect(line).toMatchObject({
          event: 'product_page',
          requestId,
          status: 200,
          sections: {
            product: 'ok',
            recommendations: 'UPSTREAM_UNAVAILABLE',
            chatUnread: 'skipped',
            flags: 'ok',
          },
        });
        expect(lines[0]).not.toMatch(
          /Bearer|unrelated|cookie|@example\.com|authorization|anon_12345678/i,
        );
      } finally {
        log.mockRestore();
      }
    });

    it('S48 AS-23: the page answer carries Server-Timing with one entry per applicable section', async () => {
      const product = seedProduct(stub);
      const res = await page(product.id).expect(200);
      const names = String(res.headers['server-timing'])
        .split(',')
        .map((s) => s.trim().split(';')[0]);
      expect(names).toEqual(
        expect.arrayContaining([
          'product',
          'shop',
          'recommendations',
          'trending',
          'flags',
          'discussions',
          'videos',
          'flashSale',
          'auction',
        ]),
      );
      expect(names).not.toContain('chatUnread');
      expect(String(res.headers['server-timing'])).toMatch(/product;dur=\d/);
    });
  });

  describe('W03 B-3 GET /bff/cart', () => {
    // The real shape issued by the orders domain: `guest:<uuid>.<signature>` (the colon once made the BFF drop the cookie).
    const GUEST = 'guest:f38e6db8-af73-4e85-a7b1-b9ffcb76f4f4.-B3X5QLLaCsr15Vnv-y82NpGxSKP1ydgiFebDsZRQzM';
    const cartPage = () => ctx.http().get('/api/bff/cart');
    const seedCart = (n: number) => {
      const products = Array.from({ length: n }, () => seedProduct(stub));
      stub.respond('cart', {
        body: cartFixture(products.map((p) => p.id)),
      });
      return products;
    };
    const parseCart = (body: unknown) => cartPageResponseSchema.parse(body);

    it('anonymous guest cart: the cart cookie (only it) is forwarded, lines are composed in cart order', async () => {
      const products = seedCart(2);
      const res = await cartPage()
        .set('Cookie', `cart=${GUEST}; unrelated=1`)
        .expect(200);
      const body = parseCart(res.body);
      expect(body.lines.map((l) => l.productId)).toEqual(
        products.map((p) => p.id),
      );
      expect(body.lines[0]).toMatchObject({
        quantity: 1,
        product: {
          title: products[0].title,
          priceMinor: products[0].priceMinor,
          currency: products[0].currency,
          inStock: true,
        },
        shop: { id: products[0].shopId, name: 'Audio Shop' },
      });
      expect(body.droppedLines).toBe(0);
      expect(body.errors).toEqual([]);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
      const call = stub.callsTo('cart')[0];
      expect(call.headers.cookie).toBe(`cart=${GUEST}`);
      expect(call.headers.authorization).toBeUndefined();
      expect(stub.callsTo('productBatch')[0].query.ids).toBe(
        products.map((p) => p.id).join(','),
      );
    });

    it('member cart: the access token reaches the cart read only, the session cookie never leaves the BFF', async () => {
      const products = seedCart(1);
      const who = await signIn(ctx, stub, { accessToken: 'access-of-B' });
      stub.calls.length = 0;
      const res = await cartPage().set('Cookie', who.cookie).expect(200);
      expect(parseCart(res.body).lines).toHaveLength(1);
      expect(stub.callsTo('cart')[0].headers.authorization).toBe(
        'Bearer access-of-B',
      );
      for (const call of stub.calls) {
        expect(call.headers.cookie).toBeUndefined();
        if (call.route !== 'cart')
          expect(call.headers.authorization).toBeUndefined();
      }
      expect(JSON.stringify(res.body)).not.toContain('access-of-B');
      void products;
    });

    it('a hidden product gives product null and no error entry', async () => {
      const products = seedCart(2);
      stub.products.delete(products[0].id);
      const body = parseCart((await cartPage().expect(200)).body);
      expect(body.lines[0].product).toBeNull();
      expect(body.lines[0].shop).toBeNull();
      expect(body.lines[1].product).not.toBeNull();
      expect(body.errors).toEqual([]);
    });

    it('products down: every product and shop is null and errors names the products section', async () => {
      seedCart(2);
      stub.respond('productBatch', { status: 503 });
      const body = parseCart((await cartPage().expect(200)).body);
      expect(body.lines).toHaveLength(2);
      for (const line of body.lines) {
        expect(line.product).toBeNull();
        expect(line.shop).toBeNull();
      }
      expect(body.errors).toEqual([
        { section: 'products', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ]);
      expect(stub.callsTo('shopBatch')).toHaveLength(0);
    });

    it('shops down: shop null with an error entry, products still shown', async () => {
      const products = seedCart(2);
      stub.respond('shopBatch', { status: 503 });
      const body = parseCart((await cartPage().expect(200)).body);
      for (const [i, line] of body.lines.entries()) {
        expect(line.shop).toBeNull();
        expect(line.product?.title).toBe(products[i].title);
      }
      expect(body.errors).toEqual([
        { section: 'shops', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ]);
    });

    it('empty cart: no product or shop call', async () => {
      const body = parseCart((await cartPage().expect(200)).body);
      expect(body).toEqual({ lines: [], droppedLines: 0, errors: [] });
      expect(stub.callsTo('productBatch')).toHaveLength(0);
      expect(stub.callsTo('shopBatch')).toHaveLength(0);
    });

    it('50 lines: one product batch of 50 ids and one shop batch of the distinct shops', async () => {
      const products = seedCart(50);
      const body = parseCart((await cartPage().expect(200)).body);
      expect(body.lines).toHaveLength(50);
      expect(stub.callsTo('productBatch')).toHaveLength(1);
      expect(stub.callsTo('productBatch')[0].query.ids.split(',')).toHaveLength(
        50,
      );
      expect(stub.callsTo('shopBatch')).toHaveLength(1);
      expect(stub.callsTo('shopBatch')[0].query.ids.split(',').sort()).toEqual(
        [...new Set(products.map((p) => p.shopId))].sort(),
      );
    });

    it('the cart read is required: its failure is the answer, status and Retry-After kept', async () => {
      stub.respond('cart', {
        status: 429,
        headers: { 'retry-after': '7' },
        body: {
          type: 'x',
          title: 'Too many',
          status: 429,
          detail: 'slow down',
          instance: '/',
          code: 'rate_limited',
          requestId: randomUUID(),
        },
      });
      const res = await cartPage().expect(429);
      expect(res.headers['retry-after']).toBe('7');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(parseProblem(res.body).code).toBe('rate_limited');
      expect(stub.callsTo('productBatch')).toHaveLength(0);
    });

    it('a cart upstream outage is 503', async () => {
      stub.respond('cart', { status: 503 });
      await cartPage().expect(503);
    });
  });

  describe('W03 B-4 GET /bff/orders/:orderId', () => {
    const orderPage = (id: string) => ctx.http().get(`/api/bff/orders/${id}`);
    const parseOrder = (body: unknown) => orderPageResponseSchema.parse(body);

    it('happy: order plus the latest payment, no secret, no-store, read with the access token', async () => {
      const order = orderFixture();
      const payment = paymentFixture(order.id, {
        requiresAction: true,
        clientSecret: 'pi_secret_never_copied',
      });
      stub.respond('order', { body: order });
      stub.respond('payments', {
        body: { items: [payment], nextCursor: null },
      });
      const who = await signIn(ctx, stub, { accessToken: 'access-of-C' });
      stub.calls.length = 0;
      const res = await orderPage(order.id)
        .set('Cookie', who.cookie)
        .expect(200);
      const body = parseOrder(res.body);
      expect(body.order).toEqual(order);
      expect(body.payment).toEqual({
        id: payment.id,
        status: 'PENDING',
        amountMinor: 9_800,
        currency: 'USD',
        failureCode: null,
        requiresAction: true,
        version: 2,
        updatedAt: payment.updatedAt,
      });
      expect(body.errors).toEqual([]);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(JSON.stringify(res.body)).not.toContain('pi_secret_never_copied');
      expect(JSON.stringify(res.body)).not.toContain('clientSecret');
      expect(stub.callsTo('order')[0].headers.authorization).toBe(
        'Bearer access-of-C',
      );
      expect(stub.callsTo('payments')[0].query).toEqual({
        orderId: order.id,
        limit: '1',
      });
    });

    it('no payment yet: payment null and no error', async () => {
      const order = orderFixture();
      stub.respond('order', { body: order });
      const who = await signIn(ctx, stub);
      const body = parseOrder(
        (await orderPage(order.id).set('Cookie', who.cookie).expect(200)).body,
      );
      expect(body.payment).toBeNull();
      expect(body.errors).toEqual([]);
    });

    it('payment upstream down: payment null plus an error entry, the order is still served', async () => {
      const order = orderFixture();
      stub.respond('order', { body: order });
      stub.respond('payments', { status: 503 });
      const who = await signIn(ctx, stub);
      const body = parseOrder(
        (await orderPage(order.id).set('Cookie', who.cookie).expect(200)).body,
      );
      expect(body.order.id).toBe(order.id);
      expect(body.payment).toBeNull();
      expect(body.errors).toEqual([
        { section: 'payment', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ]);
    });

    it("a foreign or unknown order is the upstream's 404 order_not_found", async () => {
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const res = await orderPage(randomUUID())
        .set('Cookie', who.cookie)
        .expect(404);
      expect(parseProblem(res.body).code).toBe('order_not_found');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('a malformed id is 400 and nothing is called', async () => {
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const res = await orderPage('not-a-uuid')
        .set('Cookie', who.cookie)
        .expect(400);
      expect(parseProblem(res.body).code).toBe('validation_failed');
      expect(stub.calls).toHaveLength(0);
    });

    it('no credentials is 401 and nothing is called', async () => {
      const res = await orderPage(randomUUID()).expect(401);
      expect(parseProblem(res.body).code).toBe('unauthenticated');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stub.calls).toHaveLength(0);
    });

    it('an upstream 401 rejects the credential', async () => {
      stub.respond('order', { status: 401 });
      const who = await signIn(ctx, stub);
      const res = await orderPage(randomUUID())
        .set('Cookie', who.cookie)
        .expect(401);
      expect(parseProblem(res.body).code).toBe('invalid_token');
    });
  });
});
