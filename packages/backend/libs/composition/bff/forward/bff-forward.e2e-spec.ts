import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import {
  ALLOWED_ORIGIN,
  BffTestApp,
  createBffApp,
  resetBffRedis,
} from '../testing/app-factory';
import { seedProduct, signIn, sleep } from '../testing/helpers';
import { identitySessionFixture } from '../testing/fixtures';
import { StubUpstream } from '../testing/stub-upstream';
import { BreakerRegistry } from '../upstream/breaker-registry';

const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('BFF forwarder (authenticated pass-through of /api/*)', () => {
  let stub: StubUpstream;
  let sse: StubUpstream;
  let ctx: BffTestApp;

  beforeAll(async () => {
    stub = await StubUpstream.start();
    sse = await StubUpstream.start();
    ctx = await createBffApp({
      upstreamUrl: stub.url,
      env: { BFF_SSE_URL: sse.url },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await stub.close();
    await sse.close();
  });
  beforeEach(async () => {
    stub.reset();
    sse.reset();
    ctx.clock.set(T0);
    ctx.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
  });

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res
      .writeHead(status, {
        'content-type':
          status >= 400 ? 'application/problem+json' : 'application/json',
      })
      .end(JSON.stringify(body));
  const get = (path: string, headers: Record<string, string> = {}) =>
    ctx.http().get(`/api/bff/f/${path}`).set(headers);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    ctx
      .http()
      .post(`/api/bff/f/${path}`)
      .set(headers)
      .send(body as object);

  it('bff-forward: a cart read with a session reaches core with the bearer and the answer comes back unchanged and no-store', async () => {
    const who = await signIn(ctx, stub, { accessToken: 'ACCESS-A' });
    stub.onUnknown((call, _req, res) =>
      json(res, 200, { items: [{ sku: 'a', qty: 2 }], path: call.path }),
    );
    const res = await get('cart?expand=items', { Cookie: who.cookie }).expect(
      200,
    );
    expect(res.body).toEqual({
      items: [{ sku: 'a', qty: 2 }],
      path: '/api/cart',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    const call = stub.calls.find((c) => c.path === '/api/cart')!;
    expect(call.query).toEqual({ expand: 'items' });
    expect(call.headers.authorization).toBe('Bearer ACCESS-A');
  });

  it('bff-forward: an anonymous public GET is forwarded without credentials and keeps the upstream caching header', async () => {
    stub.onUnknown((_c, _r, res) => {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=60',
        })
        .end('{"ok":true}');
    });
    const res = await get('public/info', {
      Authorization: 'Bearer forged',
    }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const call = stub.calls.find((c) => c.path === '/api/public/info')!;
    expect(call.headers.authorization).toBeUndefined();
  });

  it('bff-forward: core never sees the Cookie, X-CSRF-Token, a forged Authorization or the browser Origin, and Set-Cookie from core never reaches the browser', async () => {
    const who = await signIn(ctx, stub, { accessToken: 'REAL' });
    stub.onUnknown((_c, _r, res) => {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'core=1; Path=/',
        })
        .end('{}');
    });
    const res = await post(
      'cart/items',
      { sku: 'a' },
      {
        Cookie: who.cookie,
        'X-CSRF-Token': who.csrf,
        Origin: ALLOWED_ORIGIN,
        Authorization: 'Bearer forged',
        'X-Anonymous-Id': 'ignored',
      },
    ).expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const call = stub.calls.find((c) => c.path === '/api/cart/items')!;
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers['x-csrf-token']).toBeUndefined();
    expect(call.headers.origin).toBeUndefined();
    expect(call.headers.authorization).toBe('Bearer REAL');
    expect(call.body).toEqual({ sku: 'a' });
  });

  it('bff-forward: the guest cart cookie reaches core and its Set-Cookie reaches the browser; other cookies do not', async () => {
    stub.onUnknown((_c, _r, res) => {
      res
        .writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': [
            'cart=guest:new.sig; Path=/; HttpOnly',
            'core=1; Path=/',
          ],
        })
        .end('{}');
    });
    const res = await post(
      'cart/items',
      { sku: 'a' },
      { Cookie: 'other=1; cart=guest:old.sig; x=2' },
    ).expect(200);
    expect(res.headers['set-cookie']).toEqual([
      'cart=guest:new.sig; Path=/; HttpOnly',
    ]);
    const call = stub.calls.find((c) => c.path === '/api/cart/items')!;
    expect(call.headers.cookie).toBe('cart=guest:old.sig');
  });

  it('bff-forward: a state-changing request with a session cookie but no CSRF token is 403 csrf_invalid and never reaches core', async () => {
    const who = await signIn(ctx, stub);
    stub.onUnknown((_c, _r, res) => json(res, 200, {}));
    const res = await post(
      'cart/items',
      { sku: 'a' },
      { Cookie: who.cookie, Origin: ALLOWED_ORIGIN },
    ).expect(403);
    expect(problemDetailsSchema.parse(res.body).code).toBe('csrf_invalid');
    expect(stub.calls.filter((c) => c.path === '/api/cart/items')).toHaveLength(
      0,
    );
  });

  it('bff-forward: a state-changing request with a session cookie and a foreign Origin is 403 origin_not_allowed', async () => {
    const who = await signIn(ctx, stub);
    stub.onUnknown((_c, _r, res) => json(res, 200, {}));
    const res = await post(
      'cart/items',
      { sku: 'a' },
      {
        Cookie: who.cookie,
        'X-CSRF-Token': who.csrf,
        Origin: 'https://evil.example',
      },
    ).expect(403);
    expect(problemDetailsSchema.parse(res.body).code).toBe(
      'origin_not_allowed',
    );
    expect(stub.calls.filter((c) => c.path === '/api/cart/items')).toHaveLength(
      0,
    );
  });

  it('bff-forward: an anonymous state-changing request needs no CSRF token and is forwarded', async () => {
    stub.onUnknown((_c, _r, res) => json(res, 202, { status: 'accepted' }));
    const res = await post('auth/password-reset/request', {
      email: 'a@example.com',
    }).expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
  });

  it('bff-forward: an expired session whose refresh is rejected answers 401 session_expired', async () => {
    const who = await signIn(ctx, stub, { expiresIn: 20 });
    stub.respond('refresh', {
      status: 401,
      body: { code: 'invalid_refresh_token' },
    });
    stub.onUnknown((_c, _r, res) => json(res, 200, {}));
    const res = await get('cart', { Cookie: who.cookie }).expect(401);
    expect(problemDetailsSchema.parse(res.body).code).toBe('session_expired');
    expect(stub.calls.filter((c) => c.path === '/api/cart')).toHaveLength(0);
  });

  it('bff-forward: a 401 from core is passed through with its code and Retry-After is kept on a 429', async () => {
    const who = await signIn(ctx, stub);
    stub.onUnknown((call, _r, res) => {
      if (call.path === '/api/orders')
        return void json(res, 401, {
          code: 'invalid_token',
          status: 401,
          title: 'Unauthorized',
          detail: 'x',
        });
      res
        .writeHead(429, {
          'content-type': 'application/problem+json',
          'retry-after': '17',
        })
        .end(JSON.stringify({ code: 'rate_limited', status: 429 }));
    });
    const unauth = await get('orders', { Cookie: who.cookie }).expect(401);
    expect(unauth.body.code).toBe('invalid_token');
    const limited = await get('orders/limited', { Cookie: who.cookie }).expect(
      429,
    );
    expect(limited.headers['retry-after']).toBe('17');
    expect(limited.body.code).toBe('rate_limited');
  });

  it.each([
    'bff/session',
    'graphql',
    'auth/login',
    'auth/refresh',
    'auth/logout',
    'auth/mfa/verify',
    'cart/%2e%2e/auth/login',
    'cart/../auth/login',
    'cart%5Cx',
  ])(
    'bff-forward: %s is not reachable through the forwarder (404 not_found, core not called)',
    async (path) => {
      stub.onUnknown((_c, _r, res) => json(res, 200, {}));
      const res = await get(path).expect(404);
      expect(problemDetailsSchema.parse(res.body).code).toBe('not_found');
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('bff-forward: a JSON body above the BFF limit is 413 payload_too_large', async () => {
    stub.onUnknown((_c, _r, res) => json(res, 200, {}));
    const res = await post('cart/items', { blob: 'x'.repeat(20_000) }).expect(
      413,
    );
    expect(problemDetailsSchema.parse(res.body).code).toBe('payload_too_large');
    expect(stub.calls).toHaveLength(0);
  });

  it('bff-forward: an unreachable core is 502 bad_gateway', async () => {
    const dead = await StubUpstream.start();
    const url = dead.url;
    await dead.close();
    const other = await createBffApp({ upstreamUrl: url });
    try {
      const res = await other.http().get('/api/bff/f/cart').expect(502);
      expect(problemDetailsSchema.parse(res.body).code).toBe('bad_gateway');
    } finally {
      await other.close();
    }
  });

  it('bff-forward: with the session store down a cookie request is 503 session_unavailable with Retry-After', async () => {
    const down = await createBffApp({
      upstreamUrl: stub.url,
      clock: ctx.clock,
    });
    try {
      const who = await signIn(down, stub);
      stub.onUnknown((_c, _r, res) => json(res, 200, {}));
      down.redis.client.disconnect();
      const res = await down
        .http()
        .get('/api/bff/f/cart')
        .set('Cookie', who.cookie)
        .expect(503);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'session_unavailable',
      );
      expect(res.headers['retry-after']).toBeDefined();
      expect(stub.calls.filter((c) => c.path === '/api/cart')).toHaveLength(0);
    } finally {
      await down.close().catch(() => undefined);
    }
  });

  it('bff-forward: two concurrent requests with an expiring token cause one refresh', async () => {
    const who = await signIn(ctx, stub, { expiresIn: 20 });
    stub.respond('refresh', {
      body: identitySessionFixture({
        accessToken: 'ROTATED',
        refreshToken: 'rotated-refresh',
      }),
      delayMs: 100,
    });
    stub.onUnknown((_c, _r, res) => json(res, 200, {}));
    const [a, b] = await Promise.all([
      get('cart', { Cookie: who.cookie }),
      get('cart', { Cookie: who.cookie }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stub.callsTo('refresh')).toHaveLength(1);
    for (const call of stub.calls.filter((c) => c.path === '/api/cart'))
      expect(call.headers.authorization).toBe('Bearer ROTATED');
  });

  it('bff-forward: a stream route goes to the SSE origin and the first event arrives before the stream ends', async () => {
    const who = await signIn(ctx, stub, { accessToken: 'SSE-TOKEN' });
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    sse.onUnknown((_c, _r, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('data: first\n\n');
      void gate.then(() => res.end('data: last\n\n'));
    });
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    const received: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/api/bff/f/streams/orders',
          headers: { Cookie: who.cookie, Accept: 'text/event-stream' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/event-stream');
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => received.push(chunk));
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
    });
    const until = Date.now() + 3_000;
    while (!received.join('').includes('first') && Date.now() < until)
      await sleep(10);
    expect(received.join('')).toContain('first');
    expect(received.join('')).not.toContain('last'); // still open
    finish();
    await done;
    expect(received.join('')).toContain('last');
    expect(sse.calls.map((c) => c.path)).toEqual(['/api/streams/orders']);
    expect(sse.calls[0].headers.authorization).toBe('Bearer SSE-TOKEN');
    expect(stub.calls.filter((c) => c.path.startsWith('/api/streams'))).toEqual(
      [],
    );
  });

  it('bff-forward: seeded product reads still work beside the forwarder (no regression of the page aggregate)', async () => {
    const product = seedProduct(stub);
    await ctx.http().get(`/api/bff/product-page/${product.id}`).expect(200);
  });
});
