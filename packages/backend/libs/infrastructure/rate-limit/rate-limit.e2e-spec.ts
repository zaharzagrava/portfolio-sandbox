import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { countStatuses, inParallel } from '@app/test/utils/async-helpers';
import { expectProblem } from '@app/test/utils/test-utils.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { AuthApiModule } from '@app/domains/identity';
import { RateLimitModule } from './rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimiterService } from './rate-limiter.service';
import { RateLimitDecision } from './rate-limit.types';

/** SD-28 against the real test Redis: exact limits under concurrency, fail modes, HTTP contract. */
describe('Rate limiting (e2e, real Redis)', () => {
  let app: INestApplication;
  let limiter: RateLimiterService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([RateLimitModule, CacheModule, AuthApiModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    limiter = app.get(RateLimiterService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('token bucket: 50 concurrent requests against a burst of 10 → exactly 10 allowed', async () => {
    const subject = `user:${v4()}`;
    const results = await inParallel(50, () => limiter.check('checkout.create', subject));
    const allowed = results.filter((r) => r.status === 'fulfilled' && r.value.allowed);
    expect(allowed).toHaveLength(10);
  });

  it('sliding window: the 6th login attempt for one account inside 15 min is rejected', async () => {
    const subject = `email:${v4()}`;
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 6; i++) decisions.push(await limiter.check('auth.login.account', subject));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, false]);
    expect(decisions[5].retryAfterMs).toBeGreaterThan(0);
  });

  it('local leases: a hot key costs far fewer Redis calls than requests, total never exceeds the budget', async () => {
    const subject = `user:${v4()}`;
    const evalSpy = jest.spyOn(app.get(RedisService).client, 'eval');
    const results = await inParallel(200, () => limiter.check('search.query', subject));
    const allowed = results.filter((r) => r.status === 'fulfilled' && r.value.allowed).length;

    expect(allowed).toBeLessThanOrEqual(60);
    expect(allowed).toBeGreaterThanOrEqual(54); // ~ capacity, minus lease slices handed out concurrently
    expect(evalSpy.mock.calls.length).toBeLessThan(200);
    evalSpy.mockRestore();
  });

  it('concurrency limiter: 2 in flight per shop, third rejected until one is released', async () => {
    const shop = `shop:${v4()}`;
    const first = await limiter.acquire('exports.concurrent', shop);
    const second = await limiter.acquire('exports.concurrent', shop);
    expect(await limiter.acquire('exports.concurrent', shop)).toBeNull();

    await first!();
    const third = await limiter.acquire('exports.concurrent', shop);
    expect(third).not.toBeNull();
    await second!();
    await third!();
  });

  it('Redis down: fail-closed policies reject, fail-open policies fall back to the in-memory limiter', async () => {
    const broken = new RateLimiterService({
      client: { eval: () => Promise.reject(new Error('ECONNREFUSED')) },
    } as unknown as RedisService);

    expect(await broken.check('checkout.create', 'user:x')).toMatchObject({ allowed: false, source: 'fail-closed' });
    expect(await broken.check('search.query', 'user:x')).toMatchObject({ allowed: true, source: 'fallback' });
  });

  it('HTTP: login is limited per account with 429, Retry-After, RateLimit-* headers and Problem Details', async () => {
    const email = `victim-${v4()}@mail.com`;
    const attempt = () => request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'wrong-password-123' });

    const results = await inParallel(8, () => attempt());
    const statuses = countStatuses(results as PromiseSettledResult<{ status: number }>[]);
    expect(statuses[401]).toBe(5);
    expect(statuses[429]).toBe(3);

    const limited = await attempt().expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-limit']).toBe('5');
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expectProblem(limited.body, { status: 429, errorName: 'Domain_RateLimitedError' });
  });
});
