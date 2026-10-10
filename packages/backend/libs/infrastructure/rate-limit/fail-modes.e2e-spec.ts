import { Logger } from '@nestjs/common';
import { FakeClock } from '@app/common/core/clock';
import type { RateLimitDecision } from './rate-limit.types';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { probeLog } from './test/probe.controller';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  LimiterInstance,
  createLimiter,
  proxyUrl,
  startStoreProxy,
  uniqueSubject,
} from './test/limiter-fixture';

const unavailable = (policy: string, failMode: 'open' | 'closed') =>
  MetricsRegistry.value('rate_limit_store_unavailable_total', {
    policy,
    fail_mode: failMode,
  }) ?? 0;

/** S50 US5: outage, timeout and lost scripts, each forced for real through a fault proxy; no mock of the store client. */
describe('S50 fail modes (e2e, real Redis through a fault proxy)', () => {
  let proxy: TcpFaultProxy;
  let direct: LimiterInstance;
  const open: LimiterInstance[] = [];

  /** An instance whose store connection runs through the proxy. */
  const viaProxy = async (
    options: Parameters<typeof createLimiter>[0] = {},
  ): Promise<LimiterInstance> => {
    const inst = await createLimiter({
      clientUrl: proxyUrl(proxy),
      clock: new FakeClock(),
      ...options,
    });
    open.push(inst);
    return inst;
  };

  /** Cuts the connection and waits until the client has noticed, so no command is written into a dying socket. */
  const breakStore = async (
    mode: 'refuse' | 'hang',
    inst?: LimiterInstance,
  ) => {
    proxy.mode = mode;
    proxy.sever();
    const target = inst ?? open[open.length - 1];
    if (target)
      await waitFor(async () => target.redis.client.status !== 'ready', {
        timeoutMs: 5_000,
        intervalMs: 10,
        description: 'client noticed the cut',
      });
  };
  const restoreStore = async (inst: LimiterInstance) => {
    proxy.mode = 'pass';
    await waitFor(async () => (await inst.redis.client.ping()) === 'PONG', {
      timeoutMs: 15_000,
      description: 'command connection reconnected',
    });
  };

  beforeAll(async () => {
    proxy = await startStoreProxy();
    direct = await createLimiter();
  });

  afterEach(async () => {
    proxy.mode = 'pass';
    proxy.delayMs = 0;
    await Promise.all(open.splice(0).map((i) => i.close()));
  });

  afterAll(async () => {
    await direct.close();
    await proxy.close();
  });

  it('S50 AS-35: a code caller on a fail-closed policy gets store-unavailable as a value, never a throw; over-limit is a different reason', async () => {
    const inst = await viaProxy();
    const subject = uniqueSubject();
    await breakStore('refuse');
    const down = await inst.limiter.check('probe.closed', subject);
    expect(down).toMatchObject({
      allowed: false,
      reason: 'store-unavailable',
      retryAfterMs: 1000,
    });
    await restoreStore(inst);
    const direct1 = await direct.limiter.check('probe.closed', uniqueSubject());
    expect(direct1.reason).toBeUndefined();
    const drained = uniqueSubject();
    for (let i = 0; i < 10; i++)
      await direct.limiter.check('probe.closed', drained);
    expect((await direct.limiter.check('probe.closed', drained)).reason).toBe(
      'limit-exceeded',
    );
  });

  it('S50 AS-27: a fail-open policy is served and the store-unavailable counter grows by one per decision', async () => {
    const inst = await viaProxy();
    await breakStore('refuse');
    const before = unavailable('probe.open60', 'open');
    const decision = await inst.limiter.check('probe.open60', uniqueSubject());
    expect(decision).toMatchObject({ allowed: true, source: 'fallback' });
    expect(unavailable('probe.open60', 'open')).toBe(before + 1);
  });

  it('S50 AS-28: with fleet size 4, 60 per minute and the store down, 15 of 20 sequential requests are served', async () => {
    const inst = await viaProxy({ config: { fallbackInstances: 4 } });
    await breakStore('refuse');
    const subject = uniqueSubject();
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 20; i++)
      decisions.push(await inst.limiter.check('probe.open60', subject));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(15);
    expect(decisions.slice(15).every((d) => !d.allowed)).toBe(true);
    expect(decisions.every((d) => d.source === 'fallback')).toBe(true);
  });

  it('S50 AS-30: three failures open the breaker; for 2 s no call reaches the store; then exactly one probe', async () => {
    const clock = new FakeClock();
    const inst = await viaProxy({ clock });
    const subject = uniqueSubject();
    await breakStore('hang');
    for (let i = 0; i < 3; i++) {
      const d = await inst.limiter.check('probe.closed', subject);
      expect(d.reason).toBe('store-unavailable');
    }
    expect(inst.guard.breaker).toBe('open');
    expect(MetricsRegistry.value('rate_limit_breaker_state')).toBe(1);

    // every attempt to reach the store goes through the script loader: count them (the client itself is untouched)
    const attempts = jest.spyOn(inst.scripts, 'run');
    for (let i = 0; i < 20; i++) {
      const d = await inst.limiter.check('probe.closed', subject);
      expect(d).toMatchObject({ allowed: false, reason: 'store-unavailable' });
    }
    expect(attempts).toHaveBeenCalledTimes(0); // zero calls while the breaker is open

    clock.advance(2_000);
    const probe = await inst.limiter.check('probe.closed', subject); // the probe, which fails (store still hangs)
    expect(probe.reason).toBe('store-unavailable');
    expect(attempts).toHaveBeenCalledTimes(1);
    expect(inst.guard.breaker).toBe('open');

    // the probe failed: another 2 s without calls
    await inst.limiter.check('probe.closed', subject);
    expect(attempts).toHaveBeenCalledTimes(1);

    // store back: the next probe succeeds and closes the breaker
    proxy.mode = 'pass';
    proxy.sever();
    await waitFor(async () => (await inst.redis.client.ping()) === 'PONG', {
      timeoutMs: 15_000,
    });
    clock.advance(2_000);
    const closed = await inst.limiter.check('probe.closed', subject);
    expect(closed.source).toBe('store');
    expect(inst.guard.breaker).toBe('closed');
    expect(MetricsRegistry.value('rate_limit_breaker_state')).toBe(0);
  });

  it('S50 AS-31: a store that accepts but never answers is abandoned after the timeout, without a retry', async () => {
    const inst = await viaProxy({ config: { storeTimeoutMs: 200 } });
    await inst.limiter.check('probe.closed', uniqueSubject()); // warm: scripts loaded
    proxy.mode = 'hang'; // the connection stays up and ready; the next command is swallowed and never answered
    const chunks = proxy.clientChunks;
    const started = Date.now();
    const d = await inst.limiter.check('probe.closed', uniqueSubject());
    const elapsed = Date.now() - started;
    expect(d).toMatchObject({ allowed: false, reason: 'store-unavailable' });
    expect(elapsed).toBeLessThan(200 + 100);
    expect(proxy.clientChunks - chunks).toBeLessThanOrEqual(1);
  });

  it('S50 AS-32: after the outage the limiter continues from the stored counters', async () => {
    const clock = new FakeClock();
    const inst = await viaProxy({ clock });
    const subject = uniqueSubject();
    for (let i = 0; i < 3; i++)
      await inst.limiter.check('probe.closed', subject); // 3 of 10 used
    await breakStore('refuse');
    for (let i = 0; i < 3; i++)
      await inst.limiter.check('probe.closed', subject); // 3 failures → breaker open
    await restoreStore(inst);
    clock.advance(2_000);
    const next = await inst.limiter.check('probe.closed', subject);
    expect(next).toMatchObject({
      allowed: true,
      source: 'store',
      remaining: 6,
    });
  });

  it('S50 AS-33: lost scripts are reloaded transparently — no failure, no breaker strike, no unavailable count', async () => {
    const inst = await viaProxy();
    const subject = uniqueSubject();
    await inst.limiter.check('probe.closed', subject);
    await inst.redis.client.script('FLUSH');
    const before = unavailable('probe.closed', 'closed');
    const d = await inst.limiter.check('probe.closed', subject);
    expect(d).toMatchObject({ allowed: true, source: 'store', remaining: 8 });
    expect(unavailable('probe.closed', 'closed')).toBe(before);
    expect(inst.guard.breaker).toBe('closed');
  });

  it('S50 AS-34: concurrency — fail-closed gives acquired:false store-unavailable; fail-open uses a semaphore of floor(2/4) → 1', async () => {
    const inst = await viaProxy({ config: { fallbackInstances: 4 } });
    await breakStore('refuse');
    const closed = await inst.limiter.acquire('probe.conc2', uniqueSubject());
    expect(closed.acquired).toBe(false);
    expect(closed.decision.reason).toBe('store-unavailable');

    const subject = uniqueSubject();
    const first = await inst.limiter.acquire('probe.conc2-open', subject);
    const second = await inst.limiter.acquire('probe.conc2-open', subject);
    expect(first.acquired).toBe(true);
    expect(first.decision.source).toBe('fallback');
    expect(second.acquired).toBe(false);
    expect(second.decision.source).toBe('fallback');
    if (first.acquired) await first.release();
    expect(
      (await inst.limiter.acquire('probe.conc2-open', subject)).acquired,
    ).toBe(true);
  });
});

/** The same outage seen from a client of a limited route (production pipeline and filter). */
describe('S50 fail modes over HTTP', () => {
  let proxy: TcpFaultProxy;
  let app: ProbeApp;
  const asUser = () => ({ 'x-user': uniqueSubject('u') });
  const sever = async () => {
    proxy.mode = 'refuse';
    proxy.sever();
    await waitFor(async () => app.redis.client.status !== 'ready', {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
  };

  beforeAll(async () => {
    proxy = await startStoreProxy();
    app = await createProbeApp({
      redisUrl: proxyUrl(proxy),
      config: { fallbackInstances: 4 },
    });
  });

  afterEach(async () => {
    probeLog.reset();
    proxy.mode = 'pass';
  });

  afterAll(async () => {
    await app.close();
    await proxy.close();
  });

  it('S50 AS-26: fail closed with the store down → 503 rate_limiter_unavailable, generic detail, Retry-After 1, handler not run', async () => {
    await sever();
    const res = await app
      .http()
      .get('/api/probe/closed')
      .set(asUser())
      .expect(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      code: 'rate_limiter_unavailable',
      status: 503,
    });
    expect(res.headers['retry-after']).toBe('1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['ratelimit']).toBeUndefined();
    expect(`${res.body.title} ${res.body.detail}`).not.toMatch(
      /redis|127\.0\.0\.1|ECONN|writeable|\d{4,5}/i,
    );
    expect(probeLog.handled).not.toContain('closed');
  });

  it('S50 AS-27: fail open with the store down → the handler runs, no RateLimit headers, counter +1', async () => {
    await sever();
    const before = unavailable('http.open', 'open');
    const res = await app
      .http()
      .get('/api/probe/open')
      .set(asUser())
      .expect(200);
    expect(res.headers['ratelimit']).toBeUndefined();
    expect(res.headers['ratelimit-policy']).toBeUndefined();
    expect(probeLog.handled).toContain('open');
    expect(unavailable('http.open', 'open')).toBe(before + 1);
  });

  it('S50 AS-28: fleet size 4 and 60 per minute → 15 of 20 sequential requests are served, the rest get 429', async () => {
    await sever();
    const headers = asUser();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++)
      statuses.push(
        (await app.http().get('/api/probe/open').set(headers)).status,
      );
    expect(statuses.filter((s) => s === 200)).toHaveLength(15);
    expect(statuses.slice(15).every((s) => s === 429)).toBe(true);
  });

  it('S50 AS-34: concurrency — fail closed answers 503; fail open admits one per process and answers 429 for the next', async () => {
    await sever();
    await app.http().post('/api/probe/slow').set(asUser()).expect(503);

    const headers = asUser();
    const first = app
      .http()
      .post('/api/probe/slow-open?mode=park')
      .set(headers)
      .then((r) => r);
    await waitFor(async () => probeLog.release !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    await app.http().post('/api/probe/slow-open').set(headers).expect(429);
    probeLog.release?.();
    expect((await first).status).toBe(201);
  });

  it('S50 AS-36: a subject extractor or cost resolver that throws follows the fail mode, never a raw 500', async () => {
    // store healthy: the fault is in the helper
    proxy.mode = 'pass';
    const closedExtractor = await app
      .http()
      .get('/api/probe/custom-throws')
      .expect(503);
    expect(closedExtractor.body.code).toBe('rate_limiter_unavailable');
    const closedCost = await app
      .http()
      .get('/api/probe/cost-throws')
      .set(asUser())
      .expect(503);
    expect(closedCost.body.code).toBe('rate_limiter_unavailable');
    expect(probeLog.handled).toEqual([]);

    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await app.http().get('/api/probe/custom-open-throws').expect(200);
      expect(probeLog.handled).toEqual(['custom-open-throws']);
      expect(
        MetricsRegistry.value('rate_limit_decisions_total', {
          policy: 'http.custom-open',
          allowed: 'true',
          source: 'fallback',
          reason: 'helper-error',
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('helper failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
