import { randomUUID } from 'node:crypto';
import { Controller, Get, Logger } from '@nestjs/common';
import { definePolicies } from './policy';
import { RateLimit, RateLimitExempt } from './rate-limit.decorator';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { httpPolicies } from './test/http-policies';
import { ProbeController } from './test/probe.controller';
import { scanKeys } from './test/limiter-fixture';

const uid = () => randomUUID();
const as = (id = uid()) => ({ 'x-user': id });

const policy = {
  algorithm: 'tokenBucket',
  limit: 5,
  windowMs: 60_000,
  key: 'user',
  failMode: 'closed',
} as const;

/** S50 US10: every route is limited, exempt with a reason, or explicitly policed; one registry, checked at startup. */
describe('S50 defaults, exemptions and registry (e2e, real Redis)', () => {
  let probe: ProbeApp;

  beforeAll(async () => {
    probe = await createProbeApp();
  });

  afterAll(async () => {
    await probe.close();
  });

  beforeEach(async () => {
    for (const key of await scanKeys(probe.redis, 'rl:{default.*|ip:*'))
      await probe.redis.client.del(key);
  });

  it('S50 AS-66: a route with no declaration gets default.read / default.write by method, keyed by user or address', async () => {
    const id = uid();
    const read = await probe
      .http()
      .get('/api/probe/plain')
      .set(as(id))
      .expect(200);
    expect(read.headers['ratelimit-policy']).toBe('"default.read";q=300;w=60');
    expect(read.headers['ratelimit']).toMatch(/^"default\.read";r=299;t=\d+$/);

    const write = await probe
      .http()
      .post('/api/probe/plain-write')
      .set(as(id))
      .expect(201);
    expect(write.headers['ratelimit-policy']).toBe('"default.write";q=60;w=60');
    for (let i = 1; i < 60; i++)
      await probe.http().post('/api/probe/plain-write').set(as(id)).expect(201);
    await probe.http().post('/api/probe/plain-write').set(as(id)).expect(429);

    // no identity → the address (never unlimited)
    await probe.http().get('/api/probe/plain').expect(200);
    expect((await scanKeys(probe.redis, 'rl:{default.read|ip:*')).length).toBe(
      1,
    );
  });

  it('S50 AS-67: an explicit policy replaces the default', async () => {
    const res = await probe
      .http()
      .get('/api/probe/token')
      .set(as())
      .expect(200);
    expect(res.headers['ratelimit-policy']).toBe('"http.p5";q=5;w=900');
    expect(res.headers['ratelimit-policy']).not.toContain('default');
  });

  it('S50 AS-68: an exempt route is unlimited and carries no rate limit headers', async () => {
    for (let i = 0; i < 100; i++) {
      const res = await probe.http().get('/api/probe/exempt').expect(200);
      expect(res.headers['ratelimit']).toBeUndefined();
      expect(res.headers['ratelimit-policy']).toBeUndefined();
    }
  });

  it('S50 AS-68: a blank exemption reason fails startup', () => {
    expect(() => RateLimitExempt('')).toThrow(/reason/);
    expect(() => RateLimitExempt('   ')).toThrow(/reason/);
    expect(() => RateLimitExempt(undefined as never)).toThrow(/reason/);
  });

  it('S50 AS-68: the exempt routes are logged once at startup, with their reasons', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    let other: ProbeApp | undefined;
    try {
      other = await createProbeApp();
      const lines = log.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('exempt from the default rate limit'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        'ProbeController.exempt (probe route that must never be limited)',
      );
    } finally {
      log.mockRestore();
      await other?.close();
    }
  });

  it('S50 AS-70: a policy name declared by two modules fails startup and names both', async () => {
    const one = definePolicies('module-one', { 'dup.name': policy });
    const two = definePolicies('module-two', { 'dup.name': policy });
    await expect(
      createProbeApp({
        controllers: [ProbeController],
        policies: [httpPolicies, one, two],
      }),
    ).rejects.toThrow(/dup\.name.*module-one.*module-two/s);
  });

  it('S50 AS-70: the same owner registering the same table twice is not a clash', async () => {
    const table = definePolicies('module-one', { 'same.name': policy });
    const app = await createProbeApp({
      policies: [httpPolicies, table, table],
    });
    await app.close();
  });

  it('S50 AS-69: an invalid table fails startup with every offence', async () => {
    const bad = definePolicies('module-bad', {
      Bad: { ...policy, limit: 0 },
      'ok.name': { ...policy, windowMs: -1 },
    } as never);
    await expect(
      createProbeApp({
        controllers: [ProbeController],
        policies: [httpPolicies, bad],
      }),
    ).rejects.toThrow(/Bad[\s\S]*ok\.name/);
  });

  it('S50 AS-71: a route naming an undeclared policy fails startup', async () => {
    @Controller('undeclared')
    class UndeclaredController {
      @Get()
      @RateLimit('nobody.declared' as never)
      get() {
        return {};
      }
    }
    await expect(
      createProbeApp({
        controllers: [UndeclaredController],
        policies: [httpPolicies],
      }),
    ).rejects.toThrow(/UndeclaredController\.get.*nobody\.declared/s);
  });

  it('S50 AS-71: a custom-keyed policy used without a subject extractor fails startup', async () => {
    @Controller('noextractor')
    class NoExtractorController {
      @Get()
      @RateLimit('http.custom')
      get() {
        return {};
      }
    }
    await expect(
      createProbeApp({
        controllers: [NoExtractorController],
        policies: [httpPolicies],
      }),
    ).rejects.toThrow(/NoExtractorController\.get.*extractor/s);
  });
});
