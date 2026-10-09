import { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { startManagementListener } from './management-listener';
import request from 'supertest';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createToolkitApp } from '@app/test/toolkit/test-app';
import { EVENT_LOOP_LAG_SAMPLER, LivenessService } from './liveness.service';
import { ReadinessService } from './readiness.service';
import { StartupService } from './startup.service';

describe('health probes (HEALTH)', () => {
  let app: INestApplication;
  let clock: FakeClock;
  let readiness: ReadinessService;
  const lag = { value: 0 };
  const state = {
    pod: true,
    shared: true,
    hang: false,
    calls: 0,
    aborted: false,
  };

  beforeAll(async () => {
    clock = new FakeClock();
    app = await createToolkitApp({
      customize: (b) =>
        b
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(EVENT_LOOP_LAG_SAMPLER)
          .useValue(() => lag.value),
    });
    await app.listen(0); // one shared server for the parallel probes
    readiness = app.get(ReadinessService);
    readiness.register({
      name: 'pod-thing',
      scope: 'pod',
      check: async () => {
        if (!state.pod) throw new Error('secret pod failure at 10.0.0.1');
      },
    });
    readiness.register({
      name: 'shared-store',
      scope: 'shared',
      check: async () => {
        state.calls++;
        if (!state.shared) throw new Error('shared down');
      },
    });
    readiness.register({
      name: 'hanging',
      scope: 'shared',
      timeoutMs: 100,
      check: (signal) =>
        state.hang
          ? new Promise<void>((_, reject) => {
              signal.addEventListener('abort', () => {
                state.aborted = true;
                reject(signal.reason);
              });
            })
          : Promise.resolve(),
    });
    await app.get(StartupService).whenStarted();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    Object.assign(state, {
      pod: true,
      shared: true,
      hang: false,
      calls: 0,
      aborted: false,
    });
    lag.value = 0;
    clock.advance(10_000); // expire the 2 s result cache
  });

  const http = () => request(app.getHttpServer());

  it('S54 AS-41: /livez answers 200 without evaluating any check', async () => {
    state.shared = false;
    await http().get('/livez').expect(200);
    expect(state.calls).toBe(0);
  });

  it('S54 AS-42: shared dependencies down do not fail /readyz, they are reported down', async () => {
    state.shared = false;
    const res = await http().get('/readyz').expect(200);
    expect(res.body.checks['shared-store']).toBe('down');
  });

  it('S54 AS-43: a failing pod-local check fails /readyz and recovers after the cache TTL', async () => {
    state.pod = false;
    await http().get('/readyz').expect(503);
    state.pod = true;
    await http().get('/readyz').expect(503); // still cached
    clock.advance(2_100);
    await http().get('/readyz').expect(200);
  });

  it('S54 AS-44: a shared check promoted to critical fails readiness only after its failure threshold', async () => {
    readiness.register({
      name: 'promoted',
      scope: 'shared',
      critical: true,
      failureThreshold: 3,
      check: async () => {
        if (!state.shared) throw new Error('down');
      },
    });
    state.shared = false;
    for (let i = 0; i < 2; i++) {
      await http().get('/readyz').expect(200);
      clock.advance(2_100);
    }
    await http().get('/readyz').expect(503);
  });

  it('S54 AS-45: /startupz and /readyz are 503 during warm-up while /livez stays 200', async () => {
    const startup = app.get(StartupService);
    startup.reset();
    startup.addWarmup('cache-fill', async () => undefined);
    await http().get('/startupz').expect(503);
    await http().get('/readyz').expect(503);
    await http().get('/livez').expect(200);
    await startup.whenStarted();
    await http().get('/startupz').expect(200);
  });

  it('S54 AS-46: startup never regresses once started, also during shutdown', async () => {
    const startup = app.get(StartupService);
    await startup.whenStarted();
    readiness.markShuttingDown();
    await http().get('/startupz').expect(200);
    readiness.resetShuttingDown();
  });

  it('S54 AS-52: liveness fails only above the extreme event-loop threshold', async () => {
    lag.value = 100;
    await http().get('/livez').expect(200);
    lag.value = 60_000;
    await http().get('/livez').expect(503);
  });

  it('S54 AS-53: heartbeat silence fails liveness; unregistering at consumer stop avoids a false failure', async () => {
    const liveness = app.get(LivenessService);
    liveness.registerHeartbeat('consumer', 5_000);
    liveness.beat('consumer');
    await http().get('/livez').expect(200);
    clock.advance(6_000);
    const res = await http().get('/livez').expect(503);
    expect(JSON.stringify(res.body)).not.toContain('uptimeSec');
    liveness.unregisterHeartbeat('consumer');
    await http().get('/livez').expect(200);
  });

  it('S54 AS-54: the management listener serves the probes for an app with no HTTP surface', async () => {
    const server = await startManagementListener(app, 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      expect((await fetch(`${base}/startupz`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(ready.headers.get('cache-control')).toBe('no-store');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('S54 AS-55: platform_ready is 1 before shutdown and 0 after; health_check_up has one series per registered check', async () => {
    await http().get('/readyz').expect(200);
    expect(MetricsRegistry.value('platform_ready')).toBe(1);
    for (const name of ['pod-thing', 'shared-store', 'hanging'])
      expect(MetricsRegistry.value('health_check_up', { check: name })).toBe(1);
    state.shared = false;
    clock.advance(2_100);
    await http().get('/readyz').expect(200);
    expect(
      MetricsRegistry.value('health_check_up', { check: 'shared-store' }),
    ).toBe(0);
    expect(MetricsRegistry.value('platform_ready')).toBe(1);
    readiness.markShuttingDown();
    expect(MetricsRegistry.value('platform_ready')).toBe(0);
    readiness.resetShuttingDown();
  });

  it('S54 AS-47: on shutdown start /readyz is 503 at once while /livez stays 200', async () => {
    readiness.markShuttingDown();
    await http().get('/readyz').expect(503);
    await http().get('/livez').expect(200);
    readiness.resetShuttingDown();
  });

  it('S54 AS-48: a hanging check is reported down at its timeout, its signal aborted, response well under 1 s', async () => {
    state.hang = true;
    const started = Date.now();
    const res = await http().get('/readyz').expect(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.body.checks.hanging).toBe('down');
    expect(state.aborted).toBe(true);
  });

  it('S54 AS-49: results are cached and concurrent probes share one evaluation', async () => {
    await Promise.all(Array.from({ length: 10 }, () => http().get('/readyz')));
    expect(state.calls).toBe(1);
    await http().get('/readyz');
    expect(state.calls).toBe(1);
  });

  it('S54 AS-50: the body has names and up/down only, never the failure message', async () => {
    state.pod = false;
    const res = await http().get('/readyz').expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|10\.0\.0\.1/);
    expect(Object.values(res.body.checks)).toEqual(
      expect.arrayContaining(['down']),
    );
  });

  it('S54 AS-51: probes carry Cache-Control: no-store', async () => {
    const res = await http().get('/livez').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
