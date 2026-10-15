import { FakeClock } from '@app/common/core/clock';
import { BREAKER_FAILURES, BREAKER_OPEN_MS } from '../domain/breaker';
import {
  ProviderCallError,
  type ProviderCallErrorKind,
  type ProviderRequest,
} from '../domain/ports/commerce-provider.port';
import { FakeShopify } from '../test/fakes/fake-shopify';
import {
  createStubResolver,
  PRIVATE_ADDRESSES,
} from '../test/fakes/stub-resolver';
import {
  createHarness,
  FakeAuth,
  type Harness,
} from '../test/fakes/provider-harness';
import {
  InMemoryBreakerPersistence,
  InMemoryRefreshLock,
  ProviderHttp,
  parseRetryAfter,
} from './provider-http';

const fake = new FakeShopify({ accessToken: 'shpat_valid' });
const apiPath = `/admin/api/${fake.apiVersion}`;
let h: Harness;

const read = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  method: 'GET',
  path: '/shop.json',
  idempotent: true,
  ...over,
});
const tokenHeader = (token: string) => ({ 'x-shopify-access-token': token });

function stack(auth?: FakeAuth, extra: Record<string, unknown> = {}) {
  h = createHarness(fake, {
    provider: 'shopify',
    policy: 'integrations.shopify',
    apiPath,
    auth: auth ?? new FakeAuth('shpat_valid', tokenHeader, 'shpat_valid'),
    ...extra,
  });
  return h;
}

async function failureOf(
  promise: Promise<unknown>,
): Promise<ProviderCallError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCallError);
    return error as ProviderCallError;
  }
  throw new Error('expected the call to fail');
}

const expectKind = async (
  promise: Promise<unknown>,
  kind: ProviderCallErrorKind,
) => expect((await failureOf(promise)).kind).toBe(kind);

beforeAll(async () => {
  await fake.start();
  fake.addProduct({ id: 1, stock: 3 });
});
afterAll(() => fake.stop());
beforeEach(() => {
  fake.clearFaults();
  fake.clearLog();
  stack();
});

describe('provider call stack', () => {
  it('S08 AS-12: a successful call returns parsed JSON, status and the checked next link', async () => {
    const res = await h.http.call(
      read({ path: '/shop.json', validate: (j) => typeof j === 'object' }),
    );
    expect(res.status).toBe(200);
    expect((res.json as { shop: { currency: string } }).shop.currency).toBe(
      'USD',
    );
    expect(res.attempts).toBe(1);
    expect(res.nextUrl).toBeNull();
    expect(fake.requests[0].headers['x-shopify-access-token']).toBe(
      'shpat_valid',
    );
    expect(h.limiter.checks).toEqual([
      { policy: 'integrations.shopify', subject: 'cred-1' },
    ]);
  });

  describe('S08 AS-54: response validation', () => {
    const cases: [string, () => void][] = [
      [
        'products is not an array',
        () =>
          fake.inject({
            fault: { kind: 'status', status: 200, json: { products: 'nope' } },
          }),
      ],
      [
        'HTML error page with status 200',
        () =>
          fake.inject({
            fault: {
              kind: 'garbage',
              body: '<html><body>Maintenance</body></html>',
            },
          }),
      ],
      [
        'JSON of the wrong type',
        () =>
          fake.inject({
            fault: { kind: 'status', status: 200, json: [1, 2, 3] },
          }),
      ],
    ];
    it.each(cases)(
      'S08 AS-54: %s -> schema_invalid, one breaker failure, no retry, nothing returned',
      async (_name, arm) => {
        arm();
        const error = await failureOf(
          h.http.call(
            read({
              path: '/products.json',
              validate: (j) =>
                Array.isArray((j as { products?: unknown })?.products),
            }),
          ),
        );
        expect(error.kind).toBe('schema_invalid');
        expect(fake.requests).toHaveLength(1);
        expect(h.breaker.state.failures).toBe(1);
      },
    );

    const links: [string, () => string][] = [
      [
        'another host',
        () =>
          `<https://evil.example.com${apiPath}/products.json?page_info=x>; rel="next"`,
      ],
      [
        'another scheme',
        () =>
          `<https://${new URL(fake.baseUrl).host}${apiPath}/products.json?page_info=x>; rel="next"`,
      ],
      [
        'not the store API path',
        () => `<${fake.baseUrl}/somewhere/else.json?page_info=x>; rel="next"`,
      ],
      [
        'a sibling path that only shares the prefix',
        () => `<${fake.baseUrl}${apiPath}-evil/products.json>; rel="next"`,
      ],
    ];
    it.each(links)(
      'S08 AS-54: Link next on %s is not followed',
      async (_name, makeLink) => {
        fake.inject({
          fault: {
            kind: 'status',
            status: 200,
            headers: { link: makeLink() },
            json: { products: [] },
          },
        });
        await expectKind(
          h.http.call(read({ path: '/products.json' })),
          'schema_invalid',
        );
        expect(h.breaker.state.failures).toBe(1);
      },
    );

    it('S08 AS-54: a Link next on the store API path is returned, parsed', async () => {
      const next = `${fake.baseUrl}${apiPath}/products.json?limit=2&page_info=abc`;
      fake.inject({
        fault: {
          kind: 'status',
          status: 200,
          headers: { link: `<${next}>; rel="next"` },
          json: { products: [] },
        },
      });
      const res = await h.http.call(read({ path: '/products.json' }));
      expect(res.nextUrl?.searchParams.get('page_info')).toBe('abc');
      expect(h.breaker.state.failures).toBe(0);
    });
  });

  describe('S08 AS-55: shared rate budget', () => {
    it('S08 AS-55: limiter store down (fails closed) -> rate_limiter_unavailable and the provider gets no call', async () => {
      h.limiter.scripted = [
        { allowed: false, retryAfterMs: 1000, reason: 'store-unavailable' },
      ];
      await expectKind(h.http.call(read()), 'rate_limiter_unavailable');
      h.limiter.scripted = [new Error('redis down')];
      await expectKind(h.http.call(read()), 'rate_limiter_unavailable');
      expect(fake.requests).toHaveLength(0);
    });

    it('S08 AS-55: an exhausted bucket makes the call wait for the refill, then it goes through once', async () => {
      h.limiter.scripted = [
        { allowed: false, retryAfterMs: 200, reason: 'limit-exceeded' },
        { allowed: false, retryAfterMs: 150, reason: 'limit-exceeded' },
      ];
      await h.http.call(read());
      expect(h.sleeps).toEqual([200, 150]);
      expect(fake.requests).toHaveLength(1);
    });

    it('S08 AS-55: a wait beyond the inline budget yields instead of sleeping', async () => {
      h.limiter.scripted = [
        { allowed: false, retryAfterMs: 120_000, reason: 'limit-exceeded' },
      ];
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('rate_limited');
      expect(error.retryAfterMs).toBe(120_000);
      expect(h.sleeps).toEqual([]);
      expect(fake.requests).toHaveLength(0);
    });

    it('S08 AS-56: a bucket paused by another worker yields with retryAfterMs and makes no call', async () => {
      h.limiter.pausedUntil = h.clock.nowMs() + 4_000;
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('paused');
      expect(error.retryAfterMs).toBe(4_000);
      expect(error.isYield).toBe(true);
      expect(fake.requests).toHaveLength(0);
    });

    it('S08 AS-55: every check and penalty is for the credential of this stack (another credential is another bucket)', async () => {
      const other = createHarness(fake, {
        provider: 'shopify',
        policy: 'integrations.shopify',
        apiPath,
        credentialId: 'cred-2',
        auth: new FakeAuth('shpat_valid', tokenHeader, 'shpat_valid'),
      });
      await h.http.call(read());
      await other.http.call(read());
      expect(h.limiter.checks.map((c) => c.subject)).toEqual(['cred-1']);
      expect(other.limiter.checks.map((c) => c.subject)).toEqual(['cred-2']);
    });
  });

  describe('S08 AS-56: Retry-After', () => {
    it('S08 AS-56: 429 with Retry-After 3 penalises the shared bucket for 3000 ms and retries once after the wait', async () => {
      fake.inject({
        fault: { kind: 'rate_limit', retryAfterSeconds: 3 },
        times: 1,
      });
      const res = await h.http.call(read());
      expect(res.status).toBe(200);
      expect(res.attempts).toBe(2);
      expect(h.limiter.penalties).toEqual([
        { policy: 'integrations.shopify', subject: 'cred-1', ms: 3000 },
      ]);
      expect(h.sleeps).toEqual([3000]);
      expect(fake.requests).toHaveLength(2);
      expect(h.breaker.state.failures).toBe(0);
    });

    it('S08 AS-56: Retry-After as an HTTP date is honoured', () => {
      const now = new Date('2026-03-01T12:00:00Z');
      expect(parseRetryAfter('120', now)).toBe(120_000);
      expect(
        parseRetryAfter(new Date(now.getTime() + 5000).toUTCString(), now),
      ).toBe(5000);
      expect(parseRetryAfter('soon', now)).toBeNull();
      expect(parseRetryAfter(undefined, now)).toBeNull();
    });

    it('S08 AS-56: Retry-After above 60 s -> rate_limited yield with the delay, nothing retried inline', async () => {
      fake.inject({ fault: { kind: 'rate_limit', retryAfterSeconds: 90 } });
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('rate_limited');
      expect(error.retryAfterMs).toBe(90_000);
      expect(fake.requests).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
      expect(h.limiter.penalties[0].ms).toBe(90_000);
    });

    it('S08 AS-56: a non-idempotent call is not retried after 429 but still penalises the bucket', async () => {
      fake.inject({ fault: { kind: 'rate_limit', retryAfterSeconds: 2 } });
      const error = await failureOf(
        h.http.call(
          read({
            method: 'POST',
            path: '/webhooks.json',
            idempotent: false,
            body: {},
          }),
        ),
      );
      expect(error.kind).toBe('rate_limited');
      expect(fake.requests).toHaveLength(1);
      expect(h.limiter.penalties).toHaveLength(1);
    });

    it('S08 AS-56: 429 on every attempt stops after 3 attempts', async () => {
      fake.inject({ fault: { kind: 'rate_limit', retryAfterSeconds: 1 } });
      await expectKind(h.http.call(read()), 'rate_limited');
      expect(fake.requests).toHaveLength(3);
    });
  });

  describe('S08 AS-57: retry policy', () => {
    it('S08 AS-57: a read that gets 503 twice then 200 succeeds on the third attempt with full-jitter waits', async () => {
      fake.inject({ fault: { kind: 'status', status: 503 }, times: 2 });
      const res = await h.http.call(read());
      expect(res.attempts).toBe(3);
      expect(fake.requests).toHaveLength(3);
      // random() = 0.5: floor(0.5 * min(8000, 500 * 2^(n-1)))
      expect(h.sleeps).toEqual([250, 500]);
      expect(h.breaker.state.failures).toBe(0);
    });

    it('S08 AS-57: the waits never exceed the 8 s cap and are jittered below the ceiling', async () => {
      const slow = createHarness(fake, {
        provider: 'shopify',
        policy: 'integrations.shopify',
        apiPath,
        random: () => 0.999999,
        auth: new FakeAuth('shpat_valid', tokenHeader, 'shpat_valid'),
      });
      fake.inject({ fault: { kind: 'status', status: 502 }, times: 2 });
      await slow.http.call(read());
      expect(slow.sleeps).toEqual([499, 999]);
    });

    it.each([400, 403, 404, 422])(
      'S08 AS-57: %i is not retried',
      async (status) => {
        fake.inject({
          fault: { kind: 'status', status, json: { errors: 'x' } },
        });
        const error = await failureOf(h.http.call(read()));
        expect(fake.requests).toHaveLength(1);
        expect(error.status).toBe(status);
        expect(error.kind).toBe(
          status === 404 ? 'gone' : status === 403 ? 'forbidden' : 'rejected',
        );
        // the provider answered: that is not an outage
        expect(h.breaker.state.failures).toBe(0);
      },
    );

    it('S08 AS-57: 503 three times -> unavailable after exactly 3 attempts and one breaker failure', async () => {
      fake.inject({ fault: { kind: 'status', status: 503 } });
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('unavailable');
      expect(error.details.attempts).toBe(3);
      expect(fake.requests).toHaveLength(3);
      expect(h.breaker.state.failures).toBe(1);
    });

    it('S08 AS-57: a non-idempotent call (webhook registration) that times out or fails is not retried', async () => {
      fake.inject({ fault: { kind: 'drop' } });
      await expectKind(
        h.http.call(
          read({
            method: 'POST',
            path: '/webhooks.json',
            idempotent: false,
            body: {},
          }),
        ),
        'network',
      );
      expect(fake.requests).toHaveLength(1);
      fake.clearFaults();
      fake.inject({ fault: { kind: 'status', status: 503 } });
      await expectKind(
        h.http.call(
          read({
            method: 'POST',
            path: '/webhooks.json',
            idempotent: false,
            body: {},
          }),
        ),
        'unavailable',
      );
      expect(fake.requests).toHaveLength(2);
    });

    it('S08 AS-57: the conditional stock write (idempotent) is retried after a dropped connection', async () => {
      fake.inject({ fault: { kind: 'drop' }, times: 1 });
      // the fake answers 422 to this empty body once the connection works: the point is the second request
      const error = await failureOf(
        h.http.call(
          read({
            method: 'POST',
            path: '/inventory_levels/set.json',
            idempotent: true,
            body: {},
          }),
        ),
      );
      expect(error.status).toBe(422);
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0].status).toBeUndefined();
    }, 10_000);
  });

  describe('S08 AS-58: timeouts', () => {
    it('S08 AS-58: a provider that never answers is aborted at the timeout, retried per AS-57, counted as ONE breaker failure', async () => {
      stack(undefined, { timeoutMs: 120 });
      fake.inject({ fault: { kind: 'delay', ms: 600 } });
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('timeout');
      expect(fake.requests).toHaveLength(3);
      expect(h.breaker.state.failures).toBe(1);
    }, 10_000);

    it('S08 AS-58: the default timeout is 15 seconds', () => {
      expect(
        new ProviderHttp({
          provider: 'shopify',
          policy: 'integrations.shopify',
          credentialId: 'c',
          origin: 'https://a.example.com',
          apiPath: '/x',
          limiter: h.limiter,
          breaker: new InMemoryBreakerPersistence(),
        })['timeoutMs'],
      ).toBe(15_000);
    });
  });

  describe('S08 AS-59: circuit breaker', () => {
    const failOnce = async () => {
      fake.inject({ fault: { kind: 'status', status: 503 }, times: 1 });
      await expectKind(h.http.call(read({ idempotent: false })), 'unavailable');
    };
    const openIt = async () => {
      for (let i = 0; i < BREAKER_FAILURES; i++) await failOnce();
    };

    it('S08 AS-59: five consecutive failed calls open the breaker for 5 minutes with one attention signal; then no provider call is made', async () => {
      for (let i = 0; i < BREAKER_FAILURES - 1; i++) await failOnce();
      expect(h.breaker.state.openUntil).toBeNull();
      await failOnce();
      expect(h.breaker.state.openUntil?.getTime()).toBe(
        h.clock.nowMs() + BREAKER_OPEN_MS,
      );
      expect(h.breaker.changes.filter((c) => c.raiseAttention)).toHaveLength(1);

      const before = fake.requests.length;
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('breaker_open');
      expect(error.retryAfterMs).toBe(BREAKER_OPEN_MS);
      expect(fake.requests).toHaveLength(before);
    });

    it('S08 AS-59: a success in between resets the count (consecutive failures only)', async () => {
      for (let i = 0; i < BREAKER_FAILURES - 1; i++) await failOnce();
      await h.http.call(read());
      expect(h.breaker.state.failures).toBe(0);
      await failOnce();
      expect(h.breaker.state.openUntil).toBeNull();
    });

    it('S08 AS-59: after 5 minutes exactly one probe goes through (two callers at once); success closes the breaker', async () => {
      await openIt();
      h.clock.advance(BREAKER_OPEN_MS);
      const before = fake.requests.length;
      const results = await Promise.allSettled([
        h.http.call(read()),
        h.http.call(read()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect((rejected.reason as ProviderCallError).kind).toBe('breaker_open');
      expect(fake.requests.length - before).toBe(1);
      expect(h.breaker.state).toMatchObject({
        failures: 0,
        openUntil: null,
        halfOpen: false,
        attentionRaised: false,
      });
      await h.http.call(read());
    });

    it('S08 AS-59: a failed probe reopens for another 5 minutes without a second attention signal', async () => {
      await openIt();
      h.clock.advance(BREAKER_OPEN_MS);
      await failOnce();
      expect(h.breaker.state.openUntil?.getTime()).toBe(
        h.clock.nowMs() + BREAKER_OPEN_MS,
      );
      expect(h.breaker.changes.filter((c) => c.raiseAttention)).toHaveLength(1);
      await expectKind(h.http.call(read()), 'breaker_open');
    });

    it('S08 AS-59: refusals the provider answered on purpose (4xx, 401) do not open the breaker', async () => {
      for (let i = 0; i < BREAKER_FAILURES + 2; i++) {
        fake.inject({ fault: { kind: 'status', status: 422 }, times: 1 });
        await expectKind(h.http.call(read()), 'rejected');
      }
      expect(h.breaker.state.openUntil).toBeNull();
    });
  });

  describe('S08 AS-60: auth failure and token refresh', () => {
    it('S08 AS-60: 401 with a refresh token -> exactly one refresh, the call is retried once and succeeds', async () => {
      const auth = new FakeAuth('shpat_expired', tokenHeader, 'shpat_valid');
      stack(auth);
      const res = await h.http.call(read());
      expect(res.status).toBe(200);
      expect(auth.refreshCalls).toBe(1);
      expect(fake.requests.map((r) => r.status)).toEqual([401, 200]);
      expect(fake.requests[1].headers['x-shopify-access-token']).toBe(
        'shpat_valid',
      );
      expect(h.breaker.state.failures).toBe(0);
    });

    it('S08 AS-60: two workers see the 401 at the same moment -> exactly one refresh, both continue with the new token', async () => {
      const auth = new FakeAuth('shpat_expired', tokenHeader, 'shpat_valid');
      auth.refreshDelayMs = 40;
      stack(auth);
      const [a, b] = await Promise.all([
        h.http.call(read()),
        h.http.call(read()),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(auth.refreshCalls).toBe(1);
    });

    it('S08 AS-60: no refresh capability -> auth_failed (NEEDS_REAUTH signal), no retry, no breaker failure', async () => {
      const auth = {
        current: async () => ({
          headers: tokenHeader('shpat_bad'),
          tokenId: 'bad',
        }),
      };
      stack(auth as unknown as FakeAuth);
      const error = await failureOf(h.http.call(read()));
      expect(error.kind).toBe('auth_failed');
      expect(error.status).toBe(401);
      expect(fake.requests).toHaveLength(1);
      expect(h.breaker.state.failures).toBe(0);
    });

    it('S08 AS-60: a refused refresh -> auth_failed after one refresh attempt and one request', async () => {
      const auth = new FakeAuth('shpat_expired', tokenHeader, 'shpat_valid');
      auth.refreshResult = false;
      stack(auth);
      await expectKind(h.http.call(read()), 'auth_failed');
      expect(auth.refreshCalls).toBe(1);
      expect(fake.requests).toHaveLength(1);
    });

    it('S08 AS-60: still 401 after a refresh -> auth_failed, never a second refresh', async () => {
      const auth = new FakeAuth(
        'shpat_expired',
        tokenHeader,
        'shpat_also_wrong',
      );
      stack(auth);
      await expectKind(h.http.call(read()), 'auth_failed');
      expect(auth.refreshCalls).toBe(1);
      expect(fake.requests).toHaveLength(2);
    });

    it('S08 AS-60: a token already replaced by another worker is re-read under the lock, not refreshed again', async () => {
      const auth = new FakeAuth('shpat_expired', tokenHeader, 'shpat_valid');
      stack(auth);
      // Another worker refreshes between our request and our lock acquisition.
      const release = await h.lock.acquire(
        'catalog-sync:token-refresh:cred-1',
        1000,
      );
      const call = h.http.call(read());
      await new Promise((r) => setTimeout(r, 30));
      auth.token = 'shpat_valid';
      await release!();
      expect((await call).status).toBe(200);
      expect(auth.refreshCalls).toBe(0);
    });
  });

  describe('S08 AS-07: address guard on every call', () => {
    const prod = (resolver: ReturnType<typeof createStubResolver>) =>
      new ProviderHttp({
        provider: 'woocommerce',
        policy: 'integrations.woocommerce',
        credentialId: 'c',
        origin: 'https://shop.example.com',
        apiPath: '/wp-json/wc/v3',
        limiter: h.limiter,
        breaker: new InMemoryBreakerPersistence(),
        resolver: resolver.resolve,
      });

    it.each(Object.entries(PRIVATE_ADDRESSES))(
      'S08 AS-07: a name that resolves to %s is refused before any connection',
      async (_n, address) => {
        const resolver = createStubResolver();
        resolver.set('shop.example.com', address);
        await expectKind(
          prod(resolver).call(read({ path: '/products' })),
          'blocked_address',
        );
        expect(resolver.calls).toEqual(['shop.example.com']);
      },
    );

    it('S08 AS-07: DNS rebinding - the address is resolved again on every call and a later private answer is refused', async () => {
      const resolver = createStubResolver();
      resolver.set('shop.example.com', PRIVATE_ADDRESSES.private10);
      const http = prod(resolver);
      await expectKind(http.call(read()), 'blocked_address');
      await expectKind(http.call(read()), 'blocked_address');
      expect(resolver.calls).toHaveLength(2);
    });

    it('S08 AS-07: a redirect is refused (never followed) and is not an outage', async () => {
      fake.inject({
        fault: {
          kind: 'status',
          status: 302,
          headers: { location: 'http://169.254.169.254/latest' },
        },
      });
      await expectKind(h.http.call(read()), 'blocked_address');
      expect(fake.requests).toHaveLength(1);
      expect(h.breaker.state.failures).toBe(0);
    });

    it('S08 AS-80: the test-only network option is refused in production', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(
          () =>
            new ProviderHttp({
              provider: 'shopify',
              policy: 'integrations.shopify',
              credentialId: 'c',
              origin: fake.baseUrl,
              apiPath,
              limiter: h.limiter,
              breaker: new InMemoryBreakerPersistence(),
              unsafeTestNetwork: {
                allowHttpHosts: ['127.0.0.1'],
                allowPrivateHosts: ['127.0.0.1'],
              },
            }),
        ).toThrow(/production/);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  it('S08 AS-78: failures carry no URL, token or response text', async () => {
    fake.inject({
      fault: {
        kind: 'status',
        status: 500,
        json: { errors: 'secret-looking-detail shpat_valid' },
      },
    });
    const error = await failureOf(h.http.call(read({ idempotent: false })));
    const text = `${error.message} ${JSON.stringify({ ...error })}`;
    expect(text).not.toContain('shpat_valid');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('secret-looking-detail');
  });

  it('S08 AS-58: the call uses the injected clock for the breaker window', async () => {
    const clock = new FakeClock(new Date('2030-01-01T00:00:00Z'));
    stack(undefined, { clock });
    for (let i = 0; i < BREAKER_FAILURES; i++) {
      fake.inject({ fault: { kind: 'status', status: 500 }, times: 1 });
      await expectKind(h.http.call(read({ idempotent: false })), 'unavailable');
    }
    expect(h.breaker.state.openUntil?.toISOString()).toBe(
      '2030-01-01T00:05:00.000Z',
    );
  });

  it('keeps InMemoryRefreshLock honest: a held key is not acquired twice', async () => {
    const lock = new InMemoryRefreshLock();
    const release = await lock.acquire('k');
    expect(await lock.acquire('k')).toBeNull();
    await release!();
    expect(await lock.acquire('k')).not.toBeNull();
  });
});
