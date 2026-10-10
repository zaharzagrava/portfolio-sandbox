import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { idempotentCalls } from './test/idempotent-probe.controller';
import { probeLog } from './test/probe.controller';
import { scanKeys } from './test/limiter-fixture';

const uid = () => randomUUID();
const user = (id = uid()) => ({ 'x-user': id });

/** S50 US6: every limited route gives the same, standard answer. Production pipeline, real Redis, real filter. */
describe('S50 rate limit over HTTP (e2e, real Redis)', () => {
  let probe: ProbeApp;
  let idem: ProbeApp;

  beforeAll(async () => {
    probe = await createProbeApp();
    idem = await createProbeApp({ idempotency: true });
  });

  afterAll(async () => {
    await probe.close();
    await idem.close();
  });

  beforeEach(async () => {
    probeLog.reset();
    // address-keyed subjects are shared by every request of this process: start each test clean
    for (const key of await scanKeys(probe.redis, 'rl:{http.*|ip:*'))
      await probe.redis.client.del(key);
    for (const key of await scanKeys(probe.redis, 'rl:{probe.*|ip:*'))
      await probe.redis.client.del(key);
  });

  describe('S50 AS-06 cost above the limit', () => {
    it('S50 AS-06: 422 rate_limit_cost_exceeded with no Retry-After; nothing is consumed', async () => {
      const id = uid();
      const res = await probe
        .http()
        .get('/api/probe/costly?cost=11')
        .set(user(id))
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'rate_limit_cost_exceeded',
        status: 422,
      });
      expect(res.headers['retry-after']).toBeUndefined();
      const ok = await probe
        .http()
        .get('/api/probe/costly?cost=10')
        .set(user(id))
        .expect(200);
      expect(ok.headers['ratelimit']).toMatch(/r=0;/); // the failed request took nothing
    });

    it.each([
      ['2', 8],
      ['0.2', 9],
      ['abc', 9],
      ['-5', 9],
    ])(
      'S50 AS-07: HTTP cost %p is used as max(1, ceil(value)) (1 when not a number) → remaining %p',
      async (cost, remaining) => {
        const res = await probe
          .http()
          .get(`/api/probe/costly?cost=${cost}`)
          .set(user())
          .expect(200);
        expect(res.headers['ratelimit']).toContain(`r=${remaining};`);
      },
    );
  });

  it('S50 AS-37: an exhausted policy answers 429 problem+json with the standard headers, and the handler does not run', async () => {
    const id = uid();
    for (let i = 0; i < 5; i++)
      await probe.http().get('/api/probe/token').set(user(id)).expect(200);
    const res = await probe
      .http()
      .get('/api/probe/token')
      .set(user(id))
      .expect(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      title: 'Too Many Requests',
      status: 429,
      code: 'rate_limited',
    });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.instance).toBe('string');
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(Number(res.headers['retry-after']))).toBe(true);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.headers['ratelimit-policy']).toBe('"http.p5";q=5;w=900');
    expect(res.headers['ratelimit']).toMatch(/^"http\.p5";r=0;t=\d+$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('http.p5');
    expect(JSON.stringify(res.body)).not.toContain(id);
    expect(probeLog.handled.filter((h) => h === 'token')).toHaveLength(5);
  });

  it('S50 AS-38: success responses carry RateLimit-Policy and RateLimit; remaining decrements', async () => {
    const id = uid();
    await probe.http().get('/api/probe/token').set(user(id)).expect(200);
    const second = await probe
      .http()
      .get('/api/probe/token')
      .set(user(id))
      .expect(200);
    expect(second.headers['ratelimit-policy']).toBe('"http.p5";q=5;w=900');
    expect(second.headers['ratelimit']).toMatch(/^"http\.p5";r=3;t=\d+$/);
    const third = await probe
      .http()
      .get('/api/probe/token')
      .set(user(id))
      .expect(200);
    expect(third.headers['ratelimit']).toMatch(/r=2;/);
    expect(third.headers['ratelimit-limit']).toBeUndefined();
    expect(third.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('S50 AS-39: two policies are both listed in declaration order; the larger wait wins when both deny', async () => {
    const id = uid();
    const ok = await probe
      .http()
      .get('/api/probe/two')
      .set(user(id))
      .expect(200);
    expect(ok.headers['ratelimit-policy']).toBe(
      '"http.a20";q=20;w=60, "http.b5";q=5;w=900',
    );
    expect(ok.headers['ratelimit']).toMatch(
      /^"http\.a20";r=19;t=\d+, "http\.b5";r=4;t=\d+$/,
    );

    const both = uid();
    const subject = `user:${both}`;
    for (let i = 0; i < 20; i++) await probe.limiter.check('http.a20', subject);
    for (let i = 0; i < 5; i++) await probe.limiter.check('http.b5', subject);
    const da = await probe.limiter.check('http.a20', subject);
    const db = await probe.limiter.check('http.b5', subject);
    const res = await probe
      .http()
      .get('/api/probe/two')
      .set(user(both))
      .expect(429);
    const expected = Math.ceil(
      Math.max(da.retryAfterMs as number, db.retryAfterMs as number) / 1000,
    );
    expect(
      Math.abs(Number(res.headers['retry-after']) - expected),
    ).toBeLessThanOrEqual(2);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(
      Math.ceil((da.retryAfterMs as number) / 1000),
    );
  });

  describe('S50 AS-40 a refused request leaves every budget as it was', () => {
    it('S50 AS-40: token bucket taken first is returned', async () => {
      const id = uid();
      const subject = `user:${id}`;
      for (let i = 0; i < 2; i++)
        await probe
          .http()
          .get('/api/probe/refund-bucket')
          .set(user(id))
          .expect(200);
      const third = await probe
        .http()
        .get('/api/probe/refund-bucket')
        .set(user(id))
        .expect(429);
      expect(third.headers['ratelimit']).toMatch(
        /^"http\.a5";r=3;t=\d+, "http\.b2";r=0;t=\d+$/,
      );
      const tokens = Number(
        await probe.redis.client.hget(`rl:{http.a5|${subject}}:tb`, 'tokens'),
      );
      expect(tokens).toBeGreaterThanOrEqual(3);
      expect(tokens).toBeLessThan(3.5);
    });

    it('S50 AS-40: sliding-window count taken first is returned', async () => {
      const id = uid();
      const subject = `user:${id}`;
      for (let i = 0; i < 2; i++)
        await probe
          .http()
          .get('/api/probe/refund-window')
          .set(user(id))
          .expect(200);
      await probe
        .http()
        .get('/api/probe/refund-window')
        .set(user(id))
        .expect(429);
      const keys = await scanKeys(
        probe.redis,
        `rl:{http.a5-window|${subject}}:sw:*`,
      );
      let total = 0;
      for (const key of keys)
        total += Number(await probe.redis.client.get(key));
      expect(total).toBe(2);
    });

    it('S50 AS-40: concurrency lease taken first is released', async () => {
      const id = uid();
      const subject = `user:${id}`;
      for (let i = 0; i < 2; i++)
        await probe
          .http()
          .get('/api/probe/refund-conc')
          .set(user(id))
          .expect(200);
      await probe
        .http()
        .get('/api/probe/refund-conc')
        .set(user(id))
        .expect(429);
      expect(
        await probe.redis.client.zcard(`rl:{http.a5-conc|${subject}}:cc`),
      ).toBe(0);
    });
  });

  it('S50 AS-41: throttling runs before validation; an under-limit invalid request is a 400 that still costs one unit', async () => {
    const id = uid();
    const first = await probe
      .http()
      .post('/api/probe/validated')
      .set(user(id))
      .send({ name: 5 })
      .expect(400);
    expect(first.headers['ratelimit']).toMatch(/r=4;/);
    for (let i = 0; i < 4; i++)
      await probe
        .http()
        .post('/api/probe/validated')
        .set(user(id))
        .send({ name: 5 })
        .expect(400);
    await probe
      .http()
      .post('/api/probe/validated')
      .set(user(id))
      .send({ name: 5 })
      .expect(429);
    await probe
      .http()
      .post('/api/probe/validated')
      .set(user(id))
      .send({ name: 'ok' })
      .expect(429);
  });

  it('S50 AS-42: a request without credentials is a 401 and records nothing', async () => {
    const before = await scanKeys(probe.redis, 'rl:{http.user|*'); // other specs leave their own subjects behind
    for (let i = 0; i < 20; i++)
      await probe.http().get('/api/probe/secure').expect(401);
    expect(await scanKeys(probe.redis, 'rl:{http.ip20|*')).toEqual([]);
    expect((await scanKeys(probe.redis, 'rl:{http.user|*')).sort()).toEqual(
      before.sort(),
    );
  });

  it("S50 AS-43: a stranger cannot spend another shop's budget", async () => {
    const id = uid();
    const victim = `shop-${uid()}`;
    const mine = `shop-${uid()}`;
    for (let i = 0; i < 30; i++)
      await probe
        .http()
        .get(`/api/probe/shop/${victim}`)
        .set({ ...user(id), 'x-shops': mine })
        .expect(403);
    const untouched = await probe.limiter.check('http.shop', `shop:${victim}`);
    expect(untouched.remaining).toBe(4); // full budget of 5, this check took one
    const ok = await probe
      .http()
      .get(`/api/probe/shop/${mine}`)
      .set({ ...user(id), 'x-shops': mine })
      .expect(200);
    expect(ok.headers['ratelimit']).toMatch(/r=4;/);
  });

  it('S50 AS-44: a throttled request has no side effect', async () => {
    const id = uid();
    for (let i = 0; i < 3; i++)
      await probe.http().post('/api/probe/once').set(user(id)).expect(201);
    expect(probeLog.oneTimeTokens).toBe(3);
    await probe.http().post('/api/probe/once').set(user(id)).expect(429);
    expect(probeLog.oneTimeTokens).toBe(3);
  });

  it.each([404, 409, 500])(
    'S50 AS-45: a handler answering %p keeps the rate limit headers',
    async (status) => {
      const res = await probe
        .http()
        .get(`/api/probe/fail/${status}`)
        .set(user())
        .expect(status);
      expect(res.headers['ratelimit-policy']).toBe('"http.p5";q=5;w=900');
      expect(res.headers['ratelimit']).toMatch(/r=4;/);
    },
  );

  it('S50 AS-46: CORS preflights are answered without consuming budget', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await probe
        .http()
        .options('/api/probe/token')
        .set('Origin', 'https://shop.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBeLessThan(300);
    }
    expect(await scanKeys(probe.redis, 'rl:{http.p5|ip:*')).toEqual([]);
  });

  describe('S50 AS-47 replays consume budget (needs the idempotency store)', () => {
    it.each(['create', 'create-reversed'])(
      'S50 AS-47: %s — the same Idempotency-Key four times: created, replayed, replayed, 429; the header is Idempotency-Replayed',
      async (route) => {
        const id = uid();
        const key = `key-${uid()}`;
        const send = () =>
          idem
            .http()
            .post(`/api/probe-idem/${route}`)
            .set(user(id))
            .set('Idempotency-Key', key);
        const before = idempotentCalls.created;
        const first = await send().expect(201);
        expect(first.headers['idempotency-replayed']).toBeUndefined();
        const second = await send().expect(201);
        expect(second.headers['idempotency-replayed']).toBe('true');
        expect(
          second.headers[['idempotent', 'replayed'].join('-')],
        ).toBeUndefined();
        const third = await send().expect(201);
        expect(third.headers['idempotency-replayed']).toBe('true');
        await send().expect(429);
        expect(idempotentCalls.created).toBe(before + 1);
      },
    );

    it('S50 AS-47: the replay header is exposed to browsers under its new name only', async () => {
      const res = await idem
        .http()
        .post('/api/probe-idem/create')
        .set(user())
        .set('Origin', 'https://shop.example')
        .set('Idempotency-Key', `key-${uid()}`)
        .expect(201);
      const exposed = String(res.headers['access-control-expose-headers']);
      expect(exposed).toContain('Idempotency-Replayed');
      expect(exposed).not.toContain(['Idempotent', 'Replayed'].join('-')); // the retired spelling
    });
  });

  describe("S52 follow-up: no automatic body-hash ETag, never a 304 of the limiter's own", () => {
    it('S52: 429 and write responses carry no ETag and a conditional request is not answered 304', async () => {
      const id = uid();
      for (let i = 0; i < 5; i++)
        await probe.http().get('/api/probe/token').set(user(id)).expect(200);
      const limited = await probe
        .http()
        .get('/api/probe/token')
        .set(user(id))
        .set('If-None-Match', '*')
        .expect(429);
      expect(limited.headers['etag']).toBeUndefined();

      const write = await probe
        .http()
        .post('/api/probe/once')
        .set(user())
        .expect(201);
      expect(write.headers['etag']).toBeUndefined();
      const ok = await probe
        .http()
        .get('/api/probe/plain')
        .set(user())
        .expect(200);
      expect(ok.headers['etag']).toBeUndefined();
      await probe
        .http()
        .get('/api/probe/plain')
        .set(user())
        .set('If-None-Match', 'W/"anything"')
        .expect(200);
    });

    it("S52: bootstrap-http.ts keeps app.set('etag', false)", () => {
      const source = readFileSync(
        join(__dirname, '..', 'platform', 'bootstrap-http.ts'),
        'utf8',
      );
      expect(source).toMatch(/\.set\('etag', false\)/);
      expect(probe.app.getHttpAdapter().getInstance().get('etag')).toBe(false);
    });
  });
});
