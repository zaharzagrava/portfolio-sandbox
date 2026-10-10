import { z } from 'zod';
import {
  BffTestApp,
  createBffApp,
  resetBffRedis,
} from '../testing/app-factory';
import { seedProduct, waitFor } from '../testing/helpers';
import { StubUpstream, TripwireServer } from '../testing/stub-upstream';
import { BreakerRegistry } from './breaker-registry';
import type { Endpoint } from './endpoints/endpoint';
import { productById } from './endpoints/catalog';
import { flags } from './endpoints/flags';
import { UpstreamClient } from './upstream-client';
import { UpstreamFailure } from './upstream-error';

describe('BFF upstream client', () => {
  let stub: StubUpstream;
  let tripwire: TripwireServer;
  let ctx: BffTestApp;
  let client: UpstreamClient;

  beforeAll(async () => {
    stub = await StubUpstream.start();
    tripwire = await TripwireServer.start();
    ctx = await createBffApp({ upstreamUrl: stub.url });
    client = ctx.app.get(UpstreamClient);
  });
  afterAll(async () => {
    await ctx.close();
    await stub.close();
    await tripwire.close();
  });
  beforeEach(async () => {
    stub.reset();
    tripwire.requests.length = 0;
    ctx.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
  });

  const call = <T>(
    endpoint: Endpoint<T>,
    over: Partial<Parameters<UpstreamClient['call']>[1]> = {},
  ) =>
    client.call(endpoint, {
      credentials: { kind: 'anonymous' },
      slots: client.gate.forRequest(),
      budgetMs: 500,
      ...over,
    });
  const failureOf = async (p: Promise<unknown>): Promise<UpstreamFailure> => {
    try {
      await p;
    } catch (e) {
      return e as UpstreamFailure;
    }
    throw new Error('expected a failure');
  };
  const probe = (over: Partial<Endpoint<unknown>> = {}): Endpoint<unknown> => ({
    name: 'probe',
    upstream: 'flags',
    method: 'GET',
    path: '/api/flags',
    schema: z.unknown(),
    identity: 'none',
    sharedCache: false,
    breaker: false,
    ...over,
  });

  it('S48 AS-63: the origin is locked to the configured upstream; a path that would leave it is refused before any request', async () => {
    for (const path of [
      '//127.0.0.1:1/api/x',
      'http://evil.example/api/x',
      '/api//evil.example/x',
      '/other',
    ])
      expect((await failureOf(call(probe({ path })))).code).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
    expect(stub.calls).toHaveLength(0);
    expect(tripwire.requests).toHaveLength(0);
  });

  it('S48 AS-21: a 302 is not followed: the section is UPSTREAM_UNAVAILABLE and the other host sees nothing', async () => {
    stub.respond('flags', { redirect: `${tripwire.url}/steal` });
    const failure = await failureOf(
      call(flags(), { credentials: { kind: 'bearer', token: 'secret-token' } }),
    );
    expect(failure.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(failure.retryable).toBe(true);
    expect(tripwire.requests).toHaveLength(0);
  });

  it('S48 AS-21: only allow-listed headers are sent; identity only where the endpoint declares it', async () => {
    await call(
      probe({
        headers: {
          'x-user-id': 'forged',
          cookie: 'a=b',
          'x-forwarded-for': '203.0.113.9',
        },
      }),
      {
        credentials: {
          kind: 'bearer',
          token: 'tok',
          anonymousId: 'anon_12345678',
        },
      },
    );
    let seen = stub.calls[0].headers;
    expect(seen['x-user-id']).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined(); // identity: none
    expect(seen['x-anonymous-id']).toBeUndefined(); // not declared
    expect(seen['x-forwarded-for']).toBe('203.0.113.9');

    stub.reset();
    await call(probe({ identity: 'optional', anonymousId: true }), {
      credentials: {
        kind: 'bearer',
        token: 'tok',
        anonymousId: 'anon_12345678',
      },
    });
    seen = stub.calls[0].headers;
    expect(seen.authorization).toBe('Bearer tok');
    expect(seen['x-anonymous-id']).toBe('anon_12345678');

    stub.reset();
    await call(probe({ identity: 'optional', anonymousId: true }), {
      credentials: { kind: 'anonymous', anonymousId: 'a b' },
    });
    expect(stub.calls[0].headers['x-anonymous-id']).toBeUndefined();
    expect(stub.calls[0].headers.authorization).toBeUndefined();
  });

  it('S48 AS-10: a body that fails the endpoint schema is UPSTREAM_INVALID, not retryable', async () => {
    const id = seedProduct(stub).id;
    stub.respond('product', { body: { id } });
    const failure = await failureOf(call(productById(id)));
    expect(failure.code).toBe('UPSTREAM_INVALID');
    expect(failure.retryable).toBe(false);
  });

  it.each([
    ['400', { status: 400, body: {} }, 'UPSTREAM_INVALID', false],
    ['404', { status: 404, body: {} }, 'UPSTREAM_NOT_FOUND', false],
    ['429', { status: 429, body: {} }, 'UPSTREAM_RATE_LIMITED', true],
    ['500', { status: 500, body: {} }, 'UPSTREAM_UNAVAILABLE', true],
    ['503', { status: 503, body: {} }, 'UPSTREAM_UNAVAILABLE', true],
    ['connection reset', { reset: true }, 'UPSTREAM_UNAVAILABLE', true],
    [
      'not JSON',
      { raw: '<html>', headers: { 'content-type': 'text/html' } },
      'UPSTREAM_INVALID',
      false,
    ],
    ['broken JSON', { raw: '{"a":' }, 'UPSTREAM_INVALID', false],
    ['too slow', { body: {}, delayMs: 400 }, 'UPSTREAM_TIMEOUT', true],
  ] as const)(
    'S48 AS-13: %s → %s (retryable %s)',
    async (_name, behavior, code, retryable) => {
      stub.respond('flags', behavior);
      const failure = await failureOf(call(probe(), { budgetMs: 100 }));
      expect(failure.code).toBe(code);
      expect(failure.retryable).toBe(retryable);
      expect(failure.message).not.toMatch(/http|<html>|127\.0\.0\.1/);
    },
  );

  it('S48 AS-11: a 401 is reported as unauthorized, not as a degraded section', async () => {
    stub.respond('flags', { status: 401, body: {} });
    const failure = await failureOf(
      call(flags(), { credentials: { kind: 'bearer', token: 't' } }),
    );
    expect(failure.unauthorized).toBe(true);
  });

  it('S48 AS-07: aborting the caller reaches the socket (the stub sees the connection cut)', async () => {
    stub.respond('flags', { body: { flags: {} }, delayMs: 2_000 });
    const controller = new AbortController();
    const pending = failureOf(
      call(flags(), { signal: controller.signal, budgetMs: 5_000 }),
    );
    await waitFor(() => stub.calls.length === 1, 1_000, 'the call to arrive');
    controller.abort();
    const failure = await pending;
    expect(failure.aborted).toBe(true);
    await waitFor(
      () => stub.calls[0].aborted,
      1_000,
      'the stub to see the abort',
    );
  });

  it('S48 AS-16: a budget of zero or less is BUDGET_EXCEEDED without a call; a timeout under a deadline-limited budget is BUDGET_EXCEEDED', async () => {
    expect((await failureOf(call(flags(), { budgetMs: 0 }))).code).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(stub.calls).toHaveLength(0);
    stub.respond('flags', { body: { flags: {} }, delayMs: 300 });
    const failure = await failureOf(
      call(flags(), { budgetMs: 80, deadlineLimited: true }),
    );
    expect(failure.code).toBe('BUDGET_EXCEEDED');
  });

  it('S48 AS-24: sequential calls to one capability reuse the keep-alive connection', async () => {
    const before = stub.connections;
    for (let i = 0; i < 20; i++) await call(flags());
    expect(stub.connections - before).toBeLessThanOrEqual(2);
  });
});
