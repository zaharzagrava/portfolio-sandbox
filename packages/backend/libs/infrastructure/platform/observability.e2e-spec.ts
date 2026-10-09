import {
  Controller,
  Get,
  INestApplication,
  Logger as NestLogger,
  Module,
  Param,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { LoggingModule } from '@app/common/logging/logging.module';
import { METRIC_VIEWS } from '@app/common/telemetry/telemetry';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { HealthModule } from './../health/health.module';
import { ClockModule } from './clock.module';
import { configureHttpApp } from './bootstrap-http';

@Controller('o')
class ObservedController {
  private readonly logger = new NestLogger('Observed');

  @Get('items/:id') item(@Param('id') id: string) {
    this.logger.log(`loading item ${id}`);
    return { id };
  }
}

@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    HealthModule,
    LoggingModule,
  ],
  controllers: [ObservedController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
class ObservedModule {}

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

describe('observability (OBS)', () => {
  let app: INestApplication;
  const lines: string[] = [];
  let writeSpy: jest.SpyInstance;

  beforeAll(async () => {
    // The structured logger writes JSON lines to stdout: capture them to inspect what a request really logs.
    writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
    const moduleRef = await Test.createTestingModule({
      imports: [ObservedModule],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: false });
    configureHttpApp(app, {
      useStructuredLogger: true,
      processHandlers: false,
      globalPrefix: false,
    });
    await app.init();
    app.useLogger(app.get(Logger));
  });
  afterAll(async () => {
    writeSpy.mockRestore();
    await app.close();
  });
  beforeEach(() => {
    lines.length = 0;
  });

  const parsed = () =>
    lines
      .join('')
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, any>);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it('S54 AS-147: one access-log line per request with the route template, requestId and duration - no query, body or credentials', async () => {
    const res = await request(app.getHttpServer())
      .get('/o/items/42?token=query-secret&q=1')
      .set('Authorization', 'Bearer header-secret')
      .set('Cookie', 'sid=cookie-secret')
      .set('X-Api-Key', 'apikey-secret')
      .expect(200);
    await settle();

    const all = parsed();
    const access = all.filter((l) => l.msg === 'request completed');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      requestId: res.headers['x-request-id'],
      req: { method: 'GET' },
      route: '/o/items/:id',
      res: { statusCode: 200 },
    });
    expect(typeof access[0].durationMs).toBe('number');

    const raw = lines.join('');
    for (const secret of [
      'query-secret',
      'header-secret',
      'cookie-secret',
      'apikey-secret',
      'token=',
    ])
      expect(raw).not.toContain(secret);
    const handlerLine = all.find((l) =>
      String(l.msg ?? '').includes('loading item 42'),
    );
    expect(handlerLine?.requestId).toBe(res.headers['x-request-id']);
  });

  it('S54 AS-147: an unmatched path is access-logged with the route "unmatched"', async () => {
    await request(app.getHttpServer()).get('/nope/12345').expect(404);
    await settle();
    const access = parsed().filter((l) => l.msg === 'request completed');
    expect(access).toHaveLength(1);
    expect(access[0].route).toBe('unmatched');
  });

  it('S54 AS-147: probes are not access-logged', async () => {
    await request(app.getHttpServer()).get('/livez').expect(200);
    await settle();
    expect(parsed().filter((l) => l.msg === 'request completed')).toHaveLength(
      0,
    );
  });

  it('S54 AS-150: the metrics endpoint is not served on the public listener', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });

  describe('metric series', () => {
    const collect = async (
      record: (meter: ReturnType<MeterProvider['getMeter']>) => void,
    ) => {
      const reader = new TestReader();
      const provider = new MeterProvider({
        readers: [reader],
        views: METRIC_VIEWS,
      });
      record(provider.getMeter('spec'));
      const { resourceMetrics } = await reader.collect();
      return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    };

    it('S54 AS-150: 3 000 distinct unmatched paths fall into one route="unmatched" series', async () => {
      const metrics = await collect((meter) => {
        const duration = meter.createHistogram('http.server.request.duration');
        for (let i = 0; i < 3_000; i++)
          duration.record(0.01, {
            'http.request.method': 'GET',
            'http.response.status_code': 404,
            'url.path': `/probe/${i}`,
          });
      });
      const points = metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration',
      )!.dataPoints;
      expect(points).toHaveLength(1);
      expect(points[0].attributes).toEqual({
        'http.request.method': 'GET',
        'http.response.status_code': 404,
        'http.route': 'unmatched',
      });
    });

    it('S54 AS-150: a matched route keeps its template as the route label', async () => {
      const metrics = await collect((meter) => {
        meter.createHistogram('http.server.request.duration').record(0.01, {
          'http.request.method': 'GET',
          'http.route': '/o/items/:id',
          'http.response.status_code': 200,
        });
      });
      const points = metrics.find(
        (m) => m.descriptor.name === 'http.server.request.duration',
      )!.dataPoints;
      expect(points[0].attributes['http.route']).toBe('/o/items/:id');
    });

    it('S54 AS-150: a metric beyond 2 000 label sets puts the excess into one overflow series', async () => {
      const metrics = await collect((meter) => {
        const counter = meter.createCounter('widgets_total');
        for (let i = 0; i < 2_100; i++) counter.add(1, { thing: `t${i}` });
      });
      const points = metrics.find(
        (m) => m.descriptor.name === 'widgets_total',
      )!.dataPoints;
      expect(points.length).toBeLessThanOrEqual(2_001);
      expect(
        points.filter((p) => p.attributes['otel.metric.overflow'] === true),
      ).toHaveLength(1);
    });
  });
});
