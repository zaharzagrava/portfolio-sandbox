import {
  Body,
  CanActivate,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import http from 'node:http';
import request from 'supertest';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { mountLoadShedding } from '@app/infrastructure/platform/bootstrap-http';
import {
  EventLoopMonitor,
  LAG_SOURCE,
  LagSource,
} from './event-loop-monitor.service';
import {
  LOAD_SHEDDING_OPTIONS,
  LoadSheddingGate,
} from './load-shedding.middleware';
import { LoadSheddingModule } from './load-shedding.module';
import { LoadSheddingPriority } from './priority.decorator';

const spies = { handler: 0, auth: 0, rateLimit: 0 };

@Injectable()
class AuthSpyGuard implements CanActivate {
  canActivate(): boolean {
    spies.auth++;
    return true;
  }
}
@Injectable()
class RateLimitSpyGuard implements CanActivate {
  canActivate(): boolean {
    spies.rateLimit++;
    return true;
  }
}

@Controller('s')
class ShedController {
  @Get('default') defaultRoute() {
    spies.handler++;
    return { ok: true };
  }
  @Get('critical') @LoadSheddingPriority('critical') critical() {
    return { ok: true };
  }
  @Get('background') @LoadSheddingPriority('background') background() {
    return { ok: true };
  }
  @Get('slow/:ms') @LoadSheddingPriority('default') async slow(
    @Param('ms') ms: string,
  ) {
    await new Promise((r) => setTimeout(r, Number(ms)));
    return { ok: true };
  }
  @Get('slow-critical/:ms')
  @LoadSheddingPriority('critical')
  async slowCritical(@Param('ms') ms: string) {
    await new Promise((r) => setTimeout(r, Number(ms)));
    return { ok: true };
  }
  @Get('block/:ms') block(@Param('ms') ms: string) {
    const end = Date.now() + Number(ms);
    while (Date.now() < end) {
      /* hold the event loop */
    }
    return { blocked: Number(ms) };
  }
  @Post('post') @UseGuards(AuthSpyGuard, RateLimitSpyGuard) post(
    @Body() body: unknown,
  ) {
    spies.handler++;
    return { received: typeof body };
  }
}

class FakeLagSource implements LagSource {
  private onWindow?: (p99Ms: number) => void;
  start(onWindow: (p99Ms: number) => void): void {
    this.onWindow = onWindow;
  }
  stop(): void {}
  emit(p99Ms: number): void {
    this.onWindow!(p99Ms);
  }
}
class BrokenLagSource implements LagSource {
  start(): void {
    throw new Error('perf_hooks unavailable');
  }
  stop(): void {}
}

@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    HealthModule,
    LoadSheddingModule,
  ],
  controllers: [ShedController],
  providers: [
    AuthSpyGuard,
    RateLimitSpyGuard,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ShedTestModule {}

describe('load shedding (SHED)', () => {
  const clock = new FakeClock(new Date('2026-03-01T10:00:00.000Z'));
  const apps: INestApplication[] = [];

  const boot = async (
    opts: {
      source?: LagSource;
      options?: { thresholdMs?: number; inflightCap?: number };
    } = {},
  ) => {
    let builder = Test.createTestingModule({ imports: [ShedTestModule] })
      .overrideProvider(CLOCK)
      .useValue(clock);
    if (opts.source)
      builder = builder.overrideProvider(LAG_SOURCE).useValue(opts.source);
    if (opts.options)
      builder = builder
        .overrideProvider(LOAD_SHEDDING_OPTIONS)
        .useValue(opts.options);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ bufferLogs: false });
    mountLoadShedding(app);
    await app.listen(0);
    apps.push(app);
    return app;
  };
  const get = (app: INestApplication, path: string) =>
    request(app.getHttpServer()).get(path);
  const shedCount = (priority: string) =>
    MetricsRegistry.value('http_requests_shed_total', { priority }) ?? 0;

  beforeEach(() => {
    spies.handler = spies.auth = spies.rateLimit = 0;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    while (apps.length) await apps.pop()!.close();
  });

  it('S54 AS-73: below the threshold every priority is admitted and the gauge reads the window p99', async () => {
    const source = new FakeLagSource();
    const app = await boot({ source, options: { thresholdMs: 200 } });
    source.emit(50);
    for (const path of ['/s/background', '/s/default', '/s/critical'])
      await get(app, path).expect(200);
    expect(MetricsRegistry.value('nodejs_eventloop_lag_p99_ms')).toBe(50);
  });

  it('S54 AS-74: a shed answers 503 service_overloaded with Retry-After 1-3, a request id, the handler never runs and the metric counts it', async () => {
    const source = new FakeLagSource();
    const app = await boot({ source, options: { thresholdMs: 200 } });
    source.emit(450);
    const before = shedCount('default');
    const res = await get(app, '/s/default').expect(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 503, code: 'service_overloaded' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(['1', '2', '3']).toContain(res.headers['retry-after']);
    expect(spies.handler).toBe(0);
    expect(shedCount('default')).toBe(before + 1);
  });

  it.each([
    [250, { background: 503, default: 200, critical: 200 }],
    [450, { background: 503, default: 503, critical: 200 }],
    [1100, { background: 503, default: 503, critical: 503 }],
  ])(
    'S54 AS-75: at lag %d ms (T = 200 ms) the statuses by priority are %j',
    async (lag, expected) => {
      const source = new FakeLagSource();
      const app = await boot({ source, options: { thresholdMs: 200 } });
      source.emit(lag);
      expect((await get(app, '/s/background')).status).toBe(
        expected.background,
      );
      expect((await get(app, '/s/default')).status).toBe(expected.default);
      expect((await get(app, '/s/critical')).status).toBe(expected.critical);
    },
  );

  it('S54 AS-76: probes and the metrics path are never shed at lag 5 000 ms', async () => {
    const source = new FakeLagSource();
    const app = await boot({ source });
    source.emit(5_000);
    for (const path of [
      '/health/live',
      '/health/ready',
      '/health/startup',
      '/metrics',
    ]) {
      const res = await get(app, path);
      expect(res.body.code).not.toBe('service_overloaded');
      expect(res.headers['retry-after']).toBeUndefined();
    }
    expect((await get(app, '/health/live')).status).toBe(200);
  });

  it('S54 AS-78: at the in-flight cap default is shed, critical is admitted up to twice the cap, and default recovers', async () => {
    const source = new FakeLagSource();
    const app = await boot({
      source,
      options: { thresholdMs: 200, inflightCap: 5 },
    });
    const slow = Array.from({ length: 5 }, () =>
      get(app, '/s/slow/600').then((r) => r.status),
    );
    await new Promise((r) => setTimeout(r, 150));
    const shed = await get(app, '/s/default').expect(503);
    expect(shed.body.code).toBe('service_overloaded');
    await get(app, '/s/critical').expect(200);
    expect(await Promise.all(slow)).toEqual([200, 200, 200, 200, 200]);
    await get(app, '/s/default').expect(200);
  });

  it('S54 AS-79: requests the client aborts release their in-flight slot', async () => {
    const app = await boot({ options: { thresholdMs: 200, inflightCap: 5 } });
    const gate = app.get(LoadSheddingGate);
    const port = (app.getHttpServer().address() as { port: number }).port;
    const requests = Array.from({ length: 20 }, () => {
      const req = http.get({ port, path: '/s/slow/1500' });
      req.on('error', () => undefined);
      return req;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(gate.inflight()).toBeGreaterThan(0);
    requests.forEach((req) => req.destroy());
    await new Promise((r) => setTimeout(r, 300));
    expect(gate.inflight()).toBe(0);
    await get(app, '/s/default').expect(200);
  });

  it('S54 AS-80: the real monitor sees a 400 ms event-loop block, sheds the next request and recovers after idle windows', async () => {
    const app = await boot({ options: { thresholdMs: 50 } });
    const monitor = app.get(EventLoopMonitor);
    await get(app, '/s/block/400').expect(200);
    const until = async (done: () => boolean, ms: number) => {
      for (const start = Date.now(); !done() && Date.now() - start < ms;)
        await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => monitor.p99Ms() >= 300, 4_000);
    expect(monitor.p99Ms()).toBeGreaterThanOrEqual(300);
    await get(app, '/s/default').expect(503);
    let status = 503;
    for (
      const start = Date.now();
      status !== 200 && Date.now() - start < 8_000;
    ) {
      await new Promise((r) => setTimeout(r, 300));
      status = (await get(app, '/s/default')).status;
    }
    expect(status).toBe(200);
  }, 30_000);

  it('S54 AS-81: a shed happens before the body is read, authentication and rate limiting, with Connection: close', async () => {
    const source = new FakeLagSource();
    const app = await boot({ source, options: { thresholdMs: 200 } });
    source.emit(450);
    const body = Buffer.alloc(1024 * 1024, 'a');
    const res = await request(app.getHttpServer())
      .post('/s/post')
      .set('Authorization', 'Bearer invalid')
      .set('Content-Type', 'application/octet-stream')
      .send(body)
      .catch(
        (error: NodeJS.ErrnoException & { response?: request.Response }) =>
          error.response ?? Promise.reject(error),
      );
    expect(res.status).toBe(503);
    expect(res.headers.connection).toBe('close');
    expect(spies).toEqual({ handler: 0, auth: 0, rateLimit: 0 });
  });

  it('S54 AS-82: 1 000 shed requests in one second log at most one warn line with shedCount while the metric counts all', async () => {
    const source = new FakeLagSource();
    const app = await boot({ source, options: { thresholdMs: 200 } });
    source.emit(450);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const before = shedCount('default');
    const agent = request(app.getHttpServer());
    for (let batch = 0; batch < 10; batch++)
      await Promise.all(
        Array.from({ length: 100 }, () => agent.get('/s/default')),
      );
    const shedLines = warn.mock.calls.filter(([arg]) =>
      JSON.stringify(arg).includes('shedCount'),
    );
    expect(shedLines).toHaveLength(1);
    expect(shedCount('default')).toBe(before + 1_000);
    clock.advance(1_001);
    await get(app, '/s/default').expect(503);
    const after = warn.mock.calls.filter(([arg]) =>
      JSON.stringify(arg).includes('shedCount'),
    );
    expect(after).toHaveLength(2);
    expect(JSON.stringify(after[1][0])).toContain('"shedCount":1000');
  }, 60_000);

  it('S54 AS-83: when the monitor cannot start requests are admitted, one error is logged and no gauge series exists; windows replace each other', async () => {
    MetricsRegistry.reset();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const app = await boot({ source: new BrokenLagSource() });
    await get(app, '/s/default').expect(200);
    await get(app, '/s/background').expect(200);
    expect(
      error.mock.calls.filter(([m]) =>
        String(m).includes('event-loop monitor unavailable'),
      ),
    ).toHaveLength(1);
    expect(
      MetricsRegistry.value('nodejs_eventloop_lag_p99_ms'),
    ).toBeUndefined();
    expect(app.get(EventLoopMonitor).available()).toBe(false);

    const source = new FakeLagSource();
    const healthy = await boot({ source });
    source.emit(50);
    source.emit(10);
    expect(healthy.get(EventLoopMonitor).p99Ms()).toBe(10);
  });
});
