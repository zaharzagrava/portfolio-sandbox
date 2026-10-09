import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import {
  startStandIn,
  scripted,
  streaming,
  StandIn,
} from '@app/test/toolkit/stand-in-server';
import { HttpClientError, ResilientHttpClient } from './index';

const JSON_HEADERS = { 'content-type': 'application/json' };
const json = (
  status: number,
  body = '{"ok":true}',
  headers: Record<string, string> = {},
) => ({ status, body, headers: { ...JSON_HEADERS, ...headers } });
/** Backoff short enough that retries do not slow the suite; AS-85 uses the defaults. */
const FAST = { backoff: { baseMs: 5, maxMs: 20 } };

const failure = async (call: Promise<unknown>): Promise<HttpClientError> => {
  try {
    await call;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error('expected the call to reject');
};
const until = async (done: () => boolean, ms = 1_000) => {
  for (const start = Date.now(); !done() && Date.now() - start < ms;)
    await new Promise((r) => setTimeout(r, 20));
};

describe('resilient HTTP client (HTTP)', () => {
  const stands: StandIn[] = [];
  const stand = async (options?: Parameters<typeof startStandIn>[0]) => {
    const s = await startStandIn(options);
    stands.push(s);
    return s;
  };
  const urlOf = (s: StandIn, path = '/x') =>
    `http://127.0.0.1:${s.port}${path}`;
  let counter = 0;
  const client = (
    options: Partial<Parameters<typeof ResilientHttpClient.create>[0]> = {},
  ) =>
    ResilientHttpClient.create({
      name: `dep-${++counter}`,
      retry: FAST,
      ...options,
    });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(stands.splice(0).map((s) => s.close()));
  });

  it('S54 AS-84: a slow answer rejects with kind timeout within 300 ms and the socket is released', async () => {
    const s = await stand({
      handler: scripted([{ status: 200, delayMs: 2_000 }]),
    });
    const started = Date.now();
    const error = await failure(
      client().requestJson(urlOf(s), { timeoutMs: 200, maxAttempts: 1 }),
    );
    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(300);
    await until(() => s.openConnections === 0);
    expect(s.openConnections).toBe(0);
  });

  it('S54 AS-85: 503, 503, 200 succeeds on the 3rd attempt with jittered waits inside the backoff ceiling', async () => {
    const s = await stand({
      handler: scripted([json(503), json(503), json(200)]),
    });
    const res = await ResilientHttpClient.create({
      name: 'defaults',
    }).requestJson(urlOf(s));
    expect(res.status).toBe(200);
    expect(s.requests).toHaveLength(3);
    const gaps = [
      s.requests[1].at - s.requests[0].at,
      s.requests[2].at - s.requests[1].at,
    ];
    gaps.forEach((gap, n) =>
      expect(gap).toBeLessThanOrEqual(Math.min(5_000, 100 * 2 ** n) + 120),
    );
  });

  it.each([400, 401, 403, 404, 409, 422, 500])(
    'S54 AS-86: status %d is not retried and surfaces as kind status',
    async (status) => {
      const s = await stand({ handler: scripted([json(status)]) });
      const error = await failure(client().requestJson(urlOf(s)));
      expect(s.requests).toHaveLength(1);
      expect(error).toMatchObject({
        kind: 'status',
        status,
        attempts: 1,
        retryable: false,
      });
    },
  );

  it.each([408, 425, 429, 502, 503, 504])(
    'S54 AS-86: status %d is retried',
    async (status) => {
      const s = await stand({ handler: scripted([json(status), json(200)]) });
      expect((await client().requestJson(urlOf(s))).status).toBe(200);
      expect(s.requests).toHaveLength(2);
    },
  );

  it('S54 AS-87: Retry-After in seconds is honoured', async () => {
    const s = await stand({
      handler: scripted([json(429, '{}', { 'retry-after': '1' }), json(200)]),
    });
    const started = Date.now();
    await client().requestJson(urlOf(s));
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
  });

  it('S54 AS-87: Retry-After beyond the remaining budget fails at once with retry_after_exceeds_budget', async () => {
    const s = await stand({
      handler: scripted([
        json(503, '{}', { 'retry-after': '3600' }),
        json(200),
      ]),
    });
    const started = Date.now();
    const error = await failure(client().requestJson(urlOf(s)));
    expect(error.kind).toBe('retry_after_exceeds_budget');
    expect(Date.now() - started).toBeLessThan(500);
    expect(s.requests).toHaveLength(1);
  });

  it('S54 AS-87: an HTTP-date Retry-After 2 s ahead waits about 2 s; an unparseable one falls back to backoff', async () => {
    const s = await stand({
      handler: scripted([
        json(503, '{}', {
          'retry-after': new Date(Date.now() + 2_000).toUTCString(),
        }),
        json(200),
      ]),
    });
    const started = Date.now();
    await client().requestJson(urlOf(s));
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(3_500);

    const s2 = await stand({
      handler: scripted([
        json(503, '{}', { 'retry-after': 'soon' }),
        json(200),
      ]),
    });
    const quick = Date.now();
    await client().requestJson(urlOf(s2));
    expect(Date.now() - quick).toBeLessThan(500);
  });

  it('S54 AS-88: a POST is not retried unless declared idempotent, and then every attempt carries the same key', async () => {
    const s = await stand({ handler: scripted([json(503)]) });
    const plain = await failure(
      client().requestJson(urlOf(s), { method: 'POST', body: '{}' }),
    );
    expect(plain.attempts).toBe(1);
    expect(s.requests).toHaveLength(1);

    const s2 = await stand({
      handler: scripted([json(503), json(503), json(200)]),
    });
    await client().requestJson(urlOf(s2), {
      method: 'POST',
      body: '{}',
      idempotent: true,
      headers: { 'Idempotency-Key': 'key-12345678' },
    });
    expect(s2.requests).toHaveLength(3);
    expect(
      new Set(s2.requests.map((r) => r.headers['idempotency-key'])),
    ).toEqual(new Set(['key-12345678']));
  });

  it('S54 AS-89: more attempts than the profile allows are rejected before any network call', async () => {
    const s = await stand();
    const error = await failure(
      client().requestJson(urlOf(s), { maxAttempts: 5 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(s.requests).toHaveLength(0);
    const bg = client({ retry: { ...FAST, profile: 'background' } });
    const s2 = await stand({
      handler: scripted([
        json(503),
        json(503),
        json(503),
        json(503),
        json(200),
      ]),
    });
    expect((await bg.requestJson(urlOf(s2), { maxAttempts: 5 })).status).toBe(
      200,
    );
    const s3 = await stand({ handler: scripted([json(503)]) });
    await failure(client().requestJson(urlOf(s3), { maxAttempts: 1 }));
    expect(s3.requests).toHaveLength(1);
  });

  it('S54 AS-90: retries are capped to 10 % of requests (floor 10) per host and exhaustion is counted; another host is untouched', async () => {
    const a = await stand({ handler: scripted([json(503)]) });
    const b = await stand({ handler: scripted([json(503), json(200)]) });
    const c = client({ breaker: false });
    for (let i = 0; i < 100; i++) await failure(c.requestJson(urlOf(a)));
    const retries = a.requests.length - 100;
    expect(retries).toBeLessThanOrEqual(10);
    expect(retries).toBeGreaterThan(0);
    const dependency = (c as unknown as { name: string }).name;
    expect(
      MetricsRegistry.value('http_client_retry_budget_exhausted_total', {
        dependency,
      }) ?? 0,
    ).toBeGreaterThan(0);
    expect((await c.requestJson(urlOf(b))).status).toBe(200);
    expect(b.requests).toHaveLength(2);
  }, 30_000);

  it('S54 AS-91: the context deadline caps each attempt, stops retries, and a past deadline never touches the network', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RequestContextModule],
    }).compile();
    await moduleRef.init();
    const ctx = moduleRef.get(RequestContext);
    const s = await stand({
      handler: scripted([{ status: 200, delayMs: 2_000 }]),
    });
    const c = client();

    const started = Date.now();
    const error = await ctx.run(
      { requestId: 'req-deadline-1', deadlineAt: Date.now() + 300 },
      () => failure(c.requestJson(urlOf(s), { timeoutMs: 5_000 })),
    );
    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(700);
    expect(s.requests).toHaveLength(1);

    const past = await ctx.run(
      { requestId: 'req-deadline-2', deadlineAt: Date.now() - 1 },
      () => failure(c.requestJson(urlOf(s))),
    );
    expect(past.kind).toBe('timeout');
    expect(s.requests).toHaveLength(1);
    await moduleRef.close();
  });

  it('S54 AS-92: a caller abort rejects with kind aborted, is not retried and leaves no socket open', async () => {
    const s = await stand({
      handler: scripted([{ status: 503, delayMs: 1_000 }]),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await failure(
      client().requestJson(urlOf(s), {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    );
    expect(error).toMatchObject({
      kind: 'aborted',
      attempts: 1,
      retryable: false,
    });
    expect(s.requests).toHaveLength(1);
    await until(() => s.openConnections === 0);
    expect(s.openConnections).toBe(0);
  });

  it('S54 AS-93: a response over the size cap stops at the cap, rejects with response_too_large and is not retried', async () => {
    const written = { bytes: 0 };
    const s = await stand({ handler: streaming(5 * 1024 * 1024, written) });
    const error = await failure(client().requestJson(urlOf(s)));
    expect(error).toMatchObject({
      kind: 'response_too_large',
      retryable: false,
    });
    expect(s.requests).toHaveLength(1);
    await until(() => s.openConnections === 0);
    expect(s.openConnections).toBe(0);
    expect(written.bytes).toBeLessThan(5 * 1024 * 1024);
  });

  it('S54 AS-94: invalid JSON or a non-JSON content type is invalid_response, not retried, and the body is not echoed', async () => {
    const bad = await stand({ handler: scripted([json(200, '{"secret":')]) });
    const e1 = await failure(client().requestJson(urlOf(bad)));
    expect(e1).toMatchObject({ kind: 'invalid_response', attempts: 1 });
    expect(e1.message).not.toContain('secret');
    expect(bad.requests).toHaveLength(1);

    const html = await stand({
      handler: scripted([
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>hi</html>',
        },
      ]),
    });
    const e2 = await failure(client().requestJson(urlOf(html)));
    expect(e2.kind).toBe('invalid_response');
    expect(html.requests).toHaveLength(1);
  });

  it('S54 AS-95: a redirect is not followed by default', async () => {
    const s = await stand({
      handler: scripted([{ status: 302, headers: { location: '/elsewhere' } }]),
    });
    const error = await failure(client().requestJson(urlOf(s)));
    expect(error).toMatchObject({ kind: 'status', status: 302 });
    expect(s.requests).toHaveLength(1);
  });

  it('S54 AS-96: 20 sequential calls reuse one connection and the client idle timeout is below the server keep-alive', async () => {
    const s = await stand({
      handler: scripted([json(200)]),
      keepAliveTimeoutMs: 65_000,
    });
    const c = client();
    for (let i = 0; i < 20; i++) await c.requestJson(urlOf(s));
    expect(s.connections).toBe(1);
    expect(c.idleTimeoutMs).toBeLessThan(65_000);
  });

  it('S54 AS-97: with 2 slots and a queue of 2, six slow calls give four answers and two bulkhead_full failures; another dependency is unaffected', async () => {
    const s = await stand({
      handler: scripted([{ ...json(200), delayMs: 60 }]),
    });
    const limited = client({
      maxConcurrent: 2,
      bulkhead: { maxQueue: 2, queueWaitMs: 100 },
    });
    const other = client();
    const started = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        limited.requestJson(urlOf(s)).catch((e: HttpClientError) => {
          throw Object.assign(e, { elapsed: Date.now() - started });
        }),
      ),
    );
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ kind: 'bulkhead_full' });
      expect(r.reason.elapsed).toBeLessThan(40);
    }
    expect((await other.requestJson(urlOf(s))).status).toBe(200);
  });

  describe('circuit breaker through the client', () => {
    const breaker = {
      windowMs: 10_000,
      minimumCalls: 4,
      failureRateThreshold: 0.5,
      openDurationMs: 60_000,
      halfOpenCalls: 1,
    };

    it('S54 AS-100: an open circuit returns the fallback flagged degraded without touching the network', async () => {
      const s = await stand({ handler: scripted([json(500)]) });
      const c = client({ breaker });
      for (let i = 0; i < 4; i++) await failure(c.requestJson(urlOf(s)));
      const before = s.requests.length;
      const res = await c.requestJson<{ from: string }>(urlOf(s), {
        fallback: async () => ({ from: 'cache' }),
      });
      expect(res).toMatchObject({ degraded: true, body: { from: 'cache' } });
      expect(s.requests).toHaveLength(before);
      expect(await failure(c.requestJson(urlOf(s)))).toMatchObject({
        kind: 'circuit_open',
      });
    });

    it('S54 AS-101: one dependency opening does not affect another; 4xx never open it; slow calls count', async () => {
      const failing = await stand({ handler: scripted([json(500)]) });
      const healthy = await stand({ handler: scripted([json(200)]) });
      const a = client({ breaker });
      const b = client({ breaker });
      for (let i = 0; i < 4; i++) await failure(a.requestJson(urlOf(failing)));
      expect((await failure(a.requestJson(urlOf(failing)))).kind).toBe(
        'circuit_open',
      );
      expect(failing.requests).toHaveLength(4);
      expect((await b.requestJson(urlOf(healthy))).status).toBe(200);

      const notFound = await stand({ handler: scripted([json(404)]) });
      const c = client({ breaker });
      for (let i = 0; i < 12; i++)
        expect((await failure(c.requestJson(urlOf(notFound)))).kind).toBe(
          'status',
        );
      expect(notFound.requests).toHaveLength(12);

      const slow = await stand({
        handler: scripted([{ ...json(200), delayMs: 120 }]),
      });
      const d = client({ breaker: { ...breaker, slowCallMs: 50 } });
      for (let i = 0; i < 4; i++) await d.requestJson(urlOf(slow));
      expect((await failure(d.requestJson(urlOf(slow)))).kind).toBe(
        'circuit_open',
      );
    });

    it('S54 AS-98: the breaker closes again after the open duration on the injected clock', async () => {
      const clock = new FakeClock();
      const flaky = await stand({
        handler: scripted([
          json(500),
          json(500),
          json(500),
          json(500),
          json(200),
        ]),
      });
      const c = client({
        breaker: { ...breaker, openDurationMs: 30_000 },
        clock,
      });
      for (let i = 0; i < 4; i++) await failure(c.requestJson(urlOf(flaky)));
      expect((await failure(c.requestJson(urlOf(flaky)))).kind).toBe(
        'circuit_open',
      );
      clock.advance(30_000);
      expect((await c.requestJson(urlOf(flaky))).status).toBe(200);
    });
  });

  it('S54 AS-102: the trace parent goes out always, X-Request-Id only to internal dependencies, and no secret reaches logs or metric labels', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RequestContextModule],
    }).compile();
    await moduleRef.init();
    const ctx = moduleRef.get(RequestContext);
    const traceparent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation(
          (...args: unknown[]) => void lines.push(JSON.stringify(args)),
        );
    }
    const s = await stand({ handler: scripted([json(503)]) });
    const external = client();
    const internal = client({ internal: true });
    const call = (c: ResilientHttpClient) =>
      ctx.run({ requestId: 'req-trace-0001', traceparent }, () =>
        failure(
          c.requestJson(`${urlOf(s)}?token=abc`, {
            headers: { authorization: 'Bearer top-secret-value' },
            maxAttempts: 2,
          }),
        ),
      );
    await call(external);
    await call(internal);

    const [extFirst, , intFirst] = s.requests;
    expect(extFirst.headers.traceparent).toBe(traceparent);
    expect(extFirst.headers['x-request-id']).toBeUndefined();
    expect(intFirst.headers['x-request-id']).toBe('req-trace-0001');
    const everything =
      lines.join('\n') +
      JSON.stringify(MetricsRegistry.labelSets('http_client_requests_total')) +
      JSON.stringify(MetricsRegistry.labelSets('http_client_retries_total'));
    expect(everything).not.toContain('abc');
    expect(everything).not.toContain('top-secret-value');
    expect(lines.length).toBeGreaterThan(0);
    await moduleRef.close();
  });
});
