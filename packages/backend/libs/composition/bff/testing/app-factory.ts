import { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import supertest from 'supertest';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { BffAppModule } from '@app/bff/bff-app.module';

/** Fixed test keys, so several instances in one process share one session store and one CSRF key. */
export const TEST_SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_SESSION_KEY_OLD = Buffer.alloc(32, 9).toString('base64');
export const TEST_CSRF_KEY = Buffer.alloc(32, 5).toString('base64');
export const ALLOWED_ORIGIN = 'https://shop.example.test';

export interface BffTestOptions {
  upstreamUrl: string;
  clock?: FakeClock;
  /** Extra environment for this instance (`BFF_*`, `TRUSTED_PROXIES`, ...), set only while the app is built. */
  env?: Record<string, string | undefined>;
  /** Moves the rate limiter's store time by hand (token buckets refill only when the test says so). */
  rateLimitTime?: TimeSource;
  /** Replace providers of the production module (startup-validation specs). */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface BffTestApp {
  app: INestApplication;
  clock: FakeClock;
  redis: RedisService;
  http(): ReturnType<typeof supertest>;
  agent(): ReturnType<typeof supertest.agent>;
  close(): Promise<void>;
}

/**
 * The production `BffAppModule` booted the way `apps/bff` boots it (`configureHttpApp`: client address, body parser,
 * pipe, `/api` prefix, problem filter), over the real test Redis, with time under test control. The domain APIs are
 * the stub servers; nothing else is faked (S48 test plan).
 */
export async function createBffApp(
  options: BffTestOptions,
): Promise<BffTestApp> {
  const clock = options.clock ?? new FakeClock();
  const env: Record<string, string | undefined> = {
    BFF_UPSTREAM_URL: options.upstreamUrl,
    BFF_SESSION_KEYS: TEST_SESSION_KEY,
    BFF_CSRF_KEY: TEST_CSRF_KEY,
    BFF_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    ...options.env,
  };
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let app: INestApplication;
  try {
    let builder = Test.createTestingModule({ imports: [BffAppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock);
    if (options.rateLimitTime)
      builder = builder
        .overrideProvider(TimeSource)
        .useValue(options.rateLimitTime);
    if (options.configure) builder = options.configure(builder);
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication({ bufferLogs: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.init();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await app.listen(0, '127.0.0.1');
  const redis = app.get(RedisService);
  if (redis.client.status !== 'ready')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      redis.client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  return {
    app,
    clock,
    redis,
    http: () => supertest(app.getHttpServer()),
    agent: () => supertest.agent(app.getHttpServer()),
    async close() {
      const client = app.get(RedisService).client;
      await app.close();
      client.disconnect();
    },
  };
}

/** Removes every key this capability (and its rate-limit policies) owns, so a test starts clean. */
export async function resetBffRedis(redis: RedisService): Promise<void> {
  for (const pattern of ['bff:*', 'rl:{bff.*']) {
    let cursor = '0';
    do {
      const [next, batch] = await redis.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        500,
      );
      cursor = next;
      if (batch.length > 0) await redis.client.del(...batch);
    } while (cursor !== '0');
  }
}

export async function bffKeys(
  redis: RedisService,
  pattern: string,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}
