import { INestApplication, Module, Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { CLOCK, Clock, FakeClock } from '@app/common/core/clock';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { DatabaseModule } from '@app/infrastructure/database/database.module';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { PolicyTable } from '../policy';
import { RateLimitConfig } from '../rate-limit.config';
import { RateLimitModule } from '../rate-limit.module';
import { RateLimiterService } from '../rate-limiter.service';
import { ManualTimeSource, TimeSource } from '../time-source';
import { awaitReady, configFor, testRedisUrl } from './limiter-fixture';
import { httpPolicies } from './http-policies';
import { IdempotentProbeController } from './idempotent-probe.controller';
import { probePolicies } from './probe-policies';
import { ProbeAuthGuard, ProbeController, probeLog } from './probe.controller';

export interface ProbeAppOptions {
  /** Store URL of the limiter's connection (a fault proxy for outage specs). */
  redisUrl?: string;
  clock?: Clock;
  time?: TimeSource;
  config?: Partial<RateLimitConfig>;
  /** Controllers to serve instead of the standard probe controller. */
  controllers?: Type<unknown>[];
  /** Policy tables to register instead of the standard probe ones. */
  policies?: PolicyTable[];
  /** Adds the idempotent probe routes (needs the test Postgres). */
  idempotency?: boolean;
  /** Trusted proxy list is read from configuration; `none` by default. */
  globalPrefix?: string | false;
}

export interface ProbeApp {
  app: INestApplication;
  limiter: RateLimiterService;
  redis: RedisService;
  clock: Clock;
  http(): ReturnType<typeof supertest>;
  close(): Promise<void>;
}

/**
 * A Nest application booted the way production boots one (`configureHttpApp`: client address, pipe, prefix, CORS,
 * headers; the problem+json filter) with the real `RateLimitModule.forRoot()` over the real test Redis and the probe
 * routes. Test code only.
 */
export async function createProbeApp(
  options: ProbeAppOptions = {},
): Promise<ProbeApp> {
  const clock = options.clock ?? new FakeClock();
  const controllers = options.controllers ?? [
    ProbeController,
    ...(options.idempotency ? [IdempotentProbeController] : []),
  ];
  const policies = options.policies ?? [probePolicies, httpPolicies];

  @Module({
    imports: [
      ApiConfigModule,
      ClockModule,
      RedisModule,
      RequestContextModule,
      ErrorUtilsModule,
      HealthModule,
      ...(options.idempotency ? [DatabaseModule, IdempotencyModule] : []),
      RateLimitModule.forRoot(),
      ...policies.map((table) => RateLimitModule.forFeature(table)),
    ],
    controllers,
    providers: [
      ProbeAuthGuard,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  })
  class ProbeTestModule {}

  let builder = Test.createTestingModule({ imports: [ProbeTestModule] })
    .overrideProvider(CLOCK)
    .useValue(clock);
  if (options.redisUrl)
    builder = builder
      .overrideProvider(RedisService)
      .useValue(new RedisService(configFor(options.redisUrl)));
  if (options.time)
    builder = builder.overrideProvider(TimeSource).useValue(options.time);
  if (options.config)
    builder = builder
      .overrideProvider(RateLimitConfig)
      .useValue(Object.assign(new RateLimitConfig(), options.config));

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, {
    useStructuredLogger: false,
    processHandlers: false,
    ...(options.globalPrefix !== undefined && {
      globalPrefix: options.globalPrefix,
    }),
  });
  await app.listen(0, '127.0.0.1'); // parallel requests share one listening server instead of opening one each
  await awaitReady(app.get(RedisService));
  probeLog.reset();
  return {
    app,
    limiter: app.get(RateLimiterService),
    redis: app.get(RedisService),
    clock,
    http: () => supertest(app.getHttpServer()),
    async close() {
      const client = app.get(RedisService).client;
      await app.close();
      client.disconnect();
    },
  };
}

export { ManualTimeSource, testRedisUrl };
