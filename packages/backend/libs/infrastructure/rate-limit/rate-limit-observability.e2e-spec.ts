import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { ProbeApp, createProbeApp } from './test/probe-app';
import {
  LimiterInstance,
  createLimiter,
  proxyUrl,
  startStoreProxy,
  uniqueSubject,
} from './test/limiter-fixture';

const decisions = (
  policy: string,
  allowed: boolean,
  source: string,
  reason = 'none',
) =>
  MetricsRegistry.value('rate_limit_decisions_total', {
    policy,
    allowed: String(allowed),
    source,
    reason,
  }) ?? 0;
const observations = (policy: string, source: string) =>
  MetricsRegistry.histogramValue('rate_limit_check_duration_seconds', {
    policy,
    source,
  })?.count ?? 0;
const counter = (name: string, labels: Record<string, string>) =>
  MetricsRegistry.value(name, labels) ?? 0;

/** S50 US11: operators can see what the limiter does, without personal data in any of it. */
describe('S50 observability (e2e, real Redis)', () => {
  let proxy: TcpFaultProxy;
  let direct: LimiterInstance;
  let outage: LimiterInstance;
  const clock = new FakeClock();

  beforeAll(async () => {
    proxy = await startStoreProxy();
    direct = await createLimiter();
    outage = await createLimiter({ clientUrl: proxyUrl(proxy), clock });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await direct.close();
    await outage.close();
    await proxy.close();
  });

  it('S50 AS-74: every decision is counted once and timed once, on every path', async () => {
    // store: allowed and limit-exceeded
    const subject = uniqueSubject();
    const storeAllowed = decisions('probe.burst', true, 'store');
    const storeDenied = decisions(
      'probe.burst',
      false,
      'store',
      'limit-exceeded',
    );
    const storeTimed = observations('probe.burst', 'store');
    for (let i = 0; i < 12; i++)
      await direct.limiter.check('probe.burst', subject);
    expect(decisions('probe.burst', true, 'store') - storeAllowed).toBe(10);
    expect(
      decisions('probe.burst', false, 'store', 'limit-exceeded') - storeDenied,
    ).toBe(2);
    expect(observations('probe.burst', 'store') - storeTimed).toBe(12);

    // cost above the limit
    const permanent = decisions(
      'probe.burst',
      false,
      'store',
      'cost-exceeds-limit',
    );
    await direct.limiter.check('probe.burst', uniqueSubject(), 11);
    expect(
      decisions('probe.burst', false, 'store', 'cost-exceeds-limit') -
        permanent,
    ).toBe(1);

    // local lease
    const leased = decisions('probe.hot', true, 'local-lease');
    const hot = uniqueSubject();
    for (let i = 0; i < 4; i++) await direct.limiter.check('probe.hot', hot);
    expect(decisions('probe.hot', true, 'local-lease') - leased).toBe(3);

    // paused
    const paused = decisions('probe.burst', false, 'store', 'paused');
    const slow = uniqueSubject();
    await direct.limiter.penalize('probe.burst', slow, 5_000);
    await direct.limiter.check('probe.burst', slow);
    expect(decisions('probe.burst', false, 'store', 'paused') - paused).toBe(1);

    // penalties
    expect(
      counter('rate_limit_penalties_total', { policy: 'probe.burst' }),
    ).toBeGreaterThanOrEqual(1);

    // store down: fail closed and fail open
    proxy.mode = 'refuse';
    proxy.sever();
    await waitFor(async () => outage.redis.client.status !== 'ready', {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    const closedBefore = decisions(
      'probe.closed',
      false,
      'store',
      'store-unavailable',
    );
    const unavailableClosed = counter('rate_limit_store_unavailable_total', {
      policy: 'probe.closed',
      fail_mode: 'closed',
    });
    await outage.limiter.check('probe.closed', uniqueSubject());
    expect(
      decisions('probe.closed', false, 'store', 'store-unavailable') -
        closedBefore,
    ).toBe(1);
    expect(
      counter('rate_limit_store_unavailable_total', {
        policy: 'probe.closed',
        fail_mode: 'closed',
      }) - unavailableClosed,
    ).toBe(1);

    const openBefore = decisions('probe.open60', true, 'fallback');
    const unavailableOpen = counter('rate_limit_store_unavailable_total', {
      policy: 'probe.open60',
      fail_mode: 'open',
    });
    await outage.limiter.check('probe.open60', uniqueSubject());
    expect(decisions('probe.open60', true, 'fallback') - openBefore).toBe(1);
    expect(
      counter('rate_limit_store_unavailable_total', {
        policy: 'probe.open60',
        fail_mode: 'open',
      }) - unavailableOpen,
    ).toBe(1);
    expect(observations('probe.open60', 'fallback')).toBeGreaterThanOrEqual(1);

    // breaker gauge: 1 while open, 0 when closed again
    for (let i = 0; i < 3; i++)
      await outage.limiter.check('probe.closed', uniqueSubject());
    expect(MetricsRegistry.value('rate_limit_breaker_state')).toBe(1);
    proxy.mode = 'pass';
    await waitFor(async () => (await outage.redis.client.ping()) === 'PONG', {
      timeoutMs: 15_000,
    });
    clock.advance(2_000);
    await outage.limiter.check('probe.closed', uniqueSubject());
    expect(MetricsRegistry.value('rate_limit_breaker_state')).toBe(0);
  });

  it('S50 AS-74: the subject fallback is counted per policy, and no metric label carries a subject', async () => {
    const probe = await createProbeApp();
    try {
      const before = counter('rate_limit_subject_fallback_total', {
        policy: 'http.user',
      });
      await probe.http().get('/api/probe/user').expect(200);
      expect(
        counter('rate_limit_subject_fallback_total', { policy: 'http.user' }) -
          before,
      ).toBe(1);
    } finally {
      await probe.close();
    }
    for (const name of [
      'rate_limit_decisions_total',
      'rate_limit_check_duration_seconds',
      'rate_limit_store_unavailable_total',
      'rate_limit_subject_fallback_total',
      'rate_limit_penalties_total',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        expect(Object.keys(labels).sort()).toEqual(
          expect.not.arrayContaining(['subject', 'ip', 'user', 'email']),
        );
  });

  it('S50 AS-75: one log line per breaker transition (warn on open, info on close) and none per skipped call', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const breaker = await createLimiter({
      clientUrl: proxyUrl(proxy),
      clock: new FakeClock(),
    });
    try {
      proxy.mode = 'refuse';
      proxy.sever();
      await waitFor(async () => breaker.redis.client.status !== 'ready', {
        timeoutMs: 5_000,
        intervalMs: 10,
      });
      for (let i = 0; i < 25; i++)
        await breaker.limiter.check('probe.closed', uniqueSubject());
      const opened = warn.mock.calls.filter((c) =>
        String(c[0]).includes('closed -> open'),
      );
      expect(opened).toHaveLength(1);
      // nothing else was logged per skipped call
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('breaker')),
      ).toHaveLength(1);

      proxy.mode = 'pass';
      await waitFor(
        async () => (await breaker.redis.client.ping()) === 'PONG',
        { timeoutMs: 15_000 },
      );
      (breaker.clock as FakeClock).advance(2_000);
      await breaker.limiter.check('probe.closed', uniqueSubject());
      const transitions = log.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('breaker'));
      expect(transitions.some((m) => m.includes('half-open -> closed'))).toBe(
        true,
      );
      expect(transitions.filter((m) => m.includes('-> closed'))).toHaveLength(
        1,
      );
    } finally {
      await breaker.close();
    }
  });

  it('S50 AS-75: denials are logged structured and sampled to one per policy per second, with the request id and no personal data', async () => {
    const appClock = new FakeClock();
    const probe: ProbeApp = await createProbeApp({ clock: appClock });
    const lines: unknown[] = [];
    const capture = (...args: unknown[]) => void lines.push(...args);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    try {
      const id = `victim-${randomUUID()}`;
      for (let i = 0; i < 5; i++)
        await probe.http().get('/api/probe/token').set({ 'x-user': id });
      for (let i = 0; i < 30; i++)
        await probe
          .http()
          .get('/api/probe/token')
          .set({ 'x-user': id })
          .expect(429);
      const denials = () =>
        lines.filter(
          (l) =>
            typeof l === 'object' &&
            (l as { event?: string }).event === 'rate_limit_denied',
        );
      expect(denials()).toHaveLength(1);
      const line = denials()[0] as Record<string, unknown>;
      expect(line).toMatchObject({
        policy: 'http.p5',
        source: 'store',
        reason: 'limit-exceeded',
      });
      expect(typeof line.requestId).toBe('string');
      expect(String(line.requestId).length).toBeGreaterThan(0);
      expect(JSON.stringify(lines)).not.toContain(id);

      appClock.advance(1_001);
      await probe
        .http()
        .get('/api/probe/token')
        .set({ 'x-user': id })
        .expect(429);
      expect(denials()).toHaveLength(2);
      expect((denials()[1] as Record<string, unknown>).suppressed).toBe(29);
      expect(log).toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });
});
