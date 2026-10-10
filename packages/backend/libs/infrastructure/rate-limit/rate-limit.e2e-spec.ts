import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { countStatuses, inParallel } from '@app/test/utils/async-helpers';
import { expectProblem } from '@app/test/utils/test-utils.service';
import { AuthApiModule, identityRatePolicies } from '@app/domains/identity';
import { ordersRatePolicies } from '@app/domains/orders';
import { catalogRatePolicies } from '@app/domains/catalog';
import { statementsRatePolicies } from '@app/domains/statements';
import { RateLimitModule } from './rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimitDecision } from './rate-limit.types';
import {
  LimiterInstance,
  createLimiter,
  evalCalls,
} from './test/limiter-fixture';

/** SD-28 against the real test Redis: exact limits under concurrency, fail modes, HTTP contract. */
describe('Rate limiting (e2e, real Redis)', () => {
  let app: INestApplication;
  let a: LimiterInstance;
  const tables = [
    identityRatePolicies,
    ordersRatePolicies,
    catalogRatePolicies,
    statementsRatePolicies,
  ];

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [RateLimitModule, CacheModule, AuthApiModule],
      { stores: ['redis', 'dynamo'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    a = await createLimiter({ policies: tables, time: 'store' });
  });

  afterAll(async () => {
    await a.close();
    await app.close();
  });

  it('token bucket: 50 concurrent requests against a burst of 10 → exactly 10 allowed', async () => {
    const subject = `user:${v4()}`;
    const results = await inParallel(50, () =>
      a.limiter.check('checkout.create', subject),
    );
    const allowed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.allowed,
    );
    expect(allowed).toHaveLength(10);
  });

  it('sliding window: the 6th login attempt for one account inside 15 min is rejected', async () => {
    const subject = `email:${v4()}`;
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 6; i++)
      decisions.push(await a.limiter.check('auth.login.account', subject));
    expect(decisions.map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(decisions[5].retryAfterMs).toBeGreaterThan(0);
  });

  it('local leases: a hot key costs far fewer Redis calls than requests, total never exceeds the budget', async () => {
    const subject = `user:${v4()}`;
    const before = await evalCalls(a.redis);
    const results = await inParallel(200, () =>
      a.limiter.check('search.query', subject),
    );
    const allowed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.allowed,
    ).length;
    const calls = (await evalCalls(a.redis)) - before;

    expect(allowed).toBeLessThanOrEqual(60);
    expect(allowed).toBeGreaterThanOrEqual(54); // ~ capacity, minus lease slices handed out concurrently
    expect(calls).toBeLessThan(200);
  });

  it('concurrency limiter: 2 in flight per shop, third rejected until one is released', async () => {
    const shop = `shop:${v4()}`;
    const first = await a.limiter.acquire('exports.concurrent', shop);
    const second = await a.limiter.acquire('exports.concurrent', shop);
    expect((await a.limiter.acquire('exports.concurrent', shop)).acquired).toBe(
      false,
    );

    if (first.acquired) await first.release();
    const third = await a.limiter.acquire('exports.concurrent', shop);
    expect(third.acquired).toBe(true);
    if (second.acquired) await second.release();
    if (third.acquired) await third.release();
  });

  it('Redis down: fail-closed policies reject, fail-open policies fall back to the in-memory limiter', async () => {
    const broken = await createLimiter({
      policies: tables,
      clientUrl: 'redis://127.0.0.1:1/0',
    });

    try {
      expect(
        await broken.limiter.check('checkout.create', 'user:x'),
      ).toMatchObject({ allowed: false });
      expect(
        await broken.limiter.check('search.query', 'user:x'),
      ).toMatchObject({ allowed: true, source: 'fallback' });
    } finally {
      await broken.close();
    }
  });

  it('HTTP: login is limited per account with 429, Retry-After, RateLimit-* headers and Problem Details', async () => {
    const email = `victim-${v4()}@mail.com`;
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, password: 'wrong-password-123' });

    const results = await inParallel(8, () => attempt());
    const statuses = countStatuses(
      results as PromiseSettledResult<{ status: number }>[],
    );
    expect(statuses[401]).toBe(5);
    expect(statuses[429]).toBe(3);

    const limited = await attempt().expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // S50 AS-82: structured-field RateLimit-Policy replaces the legacy RateLimit-Limit header
    expect(limited.headers['ratelimit-policy']).toContain(
      '"auth.login.account";q=5;w=900',
    );
    expect(limited.headers['content-type']).toContain(
      'application/problem+json',
    );
    expectProblem(limited.body, {
      status: 429,
      errorName: 'Domain_RateLimitedError',
    });
  });
});
