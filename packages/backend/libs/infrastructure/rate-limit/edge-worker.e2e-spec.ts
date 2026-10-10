import { randomUUID } from 'node:crypto';
import { LimiterInstance, createLimiter } from './test/limiter-fixture';

/**
 * The edge worker's own `fetch` handler (packages/edge-be/src/index.ts) executed for real, its store being the test
 * Redis behind a REST-shaped bridge. Token verification (`jose`) is replaced: a token `good:<id>` is a verified user.
 * Proves the worker's fail-open path and its choice of subject: S50 AS-78, AS-79.
 */
jest.mock(
  'jose',
  () => ({
    createRemoteJWKSet: jest.fn(),
    decodeProtectedHeader: () => ({}),
    importSPKI: async () => ({}),
    jwtVerify: async (token: string) => {
      if (!token.startsWith('good:')) throw new Error('bad token');
      return { payload: { sub: token.slice(5) } };
    },
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const worker = require('../../../../edge-be/src/index') as {
  default: {
    fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response>;
  };
  edgeRateLimitStats: { failOpen: number };
};

describe('S50 edge worker (e2e, real Redis)', () => {
  let a: LimiterInstance;
  const STORE = 'https://edge-store.test/';
  const ORIGIN = 'https://realtime.test';
  const realFetch = global.fetch;
  let mode: 'ok' | 'down' | 'slow' | 'malformed';
  let evalKeys: string[];
  let upstream: number;

  const env = {
    UPSTASH_REDIS_REST_URL: STORE,
    UPSTASH_REDIS_REST_TOKEN: 'secret-token',
    KAFKA_BROKER: 'broker.test',
    JWT_PUBLIC_KEY: 'unused',
    REALTIME_ORIGIN: ORIGIN,
  };

  beforeAll(async () => {
    a = await createLimiter();
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await a.close();
  });

  beforeEach(() => {
    mode = 'ok';
    evalKeys = [];
    upstream = 0;
    worker.edgeRateLimitStats.failOpen = 0;
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === STORE) {
        const command = JSON.parse(String(init?.body)) as string[];
        evalKeys.push(command[3]);
        if (mode === 'down') throw new TypeError('connection refused');
        if (mode === 'slow')
          await new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            ),
          );
        if (mode === 'malformed') return Response.json({ result: 'OK' });
        const [, script, n, ...rest] = command;
        const result = await a.redis.client.eval(script, Number(n), ...rest);
        return Response.json({ result });
      }
      if (url.startsWith(ORIGIN)) {
        upstream++;
        return new Response('found', { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  });

  const search = (headers: Record<string, string> = {}) =>
    worker.default.fetch(
      new Request('https://edge.test/api/products/search?q=shoes', { headers }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined },
    );

  it.each(['down', 'malformed'] as const)(
    'S50 AS-78: a %s store fails open: the request is served, counted and logged',
    async (m) => {
      mode = m;
      const warn = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const res = await search({ 'CF-Connecting-IP': '203.0.113.7' });
      const logged = warn.mock.calls.map((c) => String(c[0])).join();
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect(upstream).toBe(1);
      expect(worker.edgeRateLimitStats.failOpen).toBe(1);
      expect(logged).toContain('edge_rate_limit_fail_open');
      expect(logged).not.toContain('secret-token');
    },
  );

  it('S50 AS-78: a store that does not answer is abandoned after 500 ms and the request is served', async () => {
    mode = 'slow';
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const started = Date.now();
    const res = await search({ 'CF-Connecting-IP': '203.0.113.7' });
    const elapsed = Date.now() - started;
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(900);
    expect(worker.edgeRateLimitStats.failOpen).toBe(1);
  });

  it('S50 AS-79: the subject is the verified user id, else the CDN address, else one shared name; forwarding headers are ignored', async () => {
    await search({
      Authorization: 'Bearer good:user-42',
      'CF-Connecting-IP': '203.0.113.1',
    });
    await search({
      'CF-Connecting-IP': '203.0.113.2',
      'X-Forwarded-For': '198.51.100.9',
      'X-Real-IP': '198.51.100.8',
    });
    await search();
    await search({
      Authorization: 'Bearer forged',
      'CF-Connecting-IP': '203.0.113.3',
    });
    const [verified, address, none, forged] = evalKeys;
    expect(verified).toContain('{user:user-42}');
    expect(address).toContain('{ip:203.0.113.2}');
    expect(address).not.toContain('198.51.100');
    expect(none).toContain('{anonymous}');
    expect(forged).toContain('{ip:203.0.113.3}');
  });

  it('S50 AS-79: two users behind one address have separate budgets', async () => {
    const ip = '203.0.113.50';
    const id = randomUUID();
    const ua = { Authorization: `Bearer good:a-${id}`, 'CF-Connecting-IP': ip };
    const ub = { Authorization: `Bearer good:b-${id}`, 'CF-Connecting-IP': ip };
    for (let i = 0; i < 120; i++) expect((await search(ua)).status).toBe(200);
    expect((await search(ua)).status).toBe(429);
    expect((await search(ub)).status).toBe(200);
  });
});
