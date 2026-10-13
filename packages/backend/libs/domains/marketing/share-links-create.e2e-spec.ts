import {
  problemDetailsSchema,
  shortLinkSchema,
} from '@marketplace-sandbox/contracts';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { inParallel } from '@app/test/utils/async-helpers';
import type { TestUser } from '@app/test/utils/catalog-app';
import { scramble, toBase62 } from './domain/codes';
import { RedisCodeSequence } from './infra/redis-code-sequence';
import { marketingRatePolicies } from './rate-limit-policies';
import {
  FRONT,
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

describe('Share links: creation, codes and aliases', () => {
  let t: ShareLinksTestApp;
  let u1: TestUser;

  beforeAll(async () => {
    t = await createShareLinksApp({ redisProxy: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    u1 = await t.user();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);

  it('S37 AS-01: creating a link answers 201 with Location, the contract body and one stored row', async () => {
    const destination = t.destination('/p/iphone-17?color=blue');
    const before =
      MetricsRegistry.value('link_created_total', { kind: 'generated' }) ?? 0;

    const res = await t.create(u1, { destination });

    expect(res.status).toBe(201);
    const link = shortLinkSchema.parse(res.body);
    expect(link.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(link).toMatchObject({
      destination,
      status: 'ACTIVE',
      kind: 'generated',
      expiresAt: null,
      shortUrl: `https://mkt.to/${link.code}`,
    });
    expect(res.headers.location).toBe(`/api/links/${link.code}`);
    expect(JSON.stringify(res.body)).not.toContain(u1.id);
    expect(res.body).not.toHaveProperty('ownerId');
    expect(res.body).not.toHaveProperty('expiresAtEpoch');

    const stored = await t.stored(link.code);
    expect(stored).toMatchObject({
      ownerId: u1.id,
      destination,
      kind: 'generated',
    });
    expect(
      MetricsRegistry.value('link_created_total', { kind: 'generated' }),
    ).toBe(before + 1);
  });

  describe('S37 AS-02: validation classes → 400 validation_failed, nothing stored', () => {
    it.each([
      ['missing destination', {}],
      ['empty destination', { destination: '' }],
      [
        'destination of 2,049 characters',
        { destination: `${FRONT}/${'a'.repeat(2049)}` },
      ],
      ['whitespace in destination', { destination: `${FRONT}/p/a b` }],
      ['unknown field', { destination: `${FRONT}/p/a`, ownerId: 'x' }],
      ['alias too short', { destination: `${FRONT}/p/a`, alias: 'abc' }],
      ['alias upper case', { destination: `${FRONT}/p/a`, alias: 'Summer' }],
      [
        'alias with double dash',
        { destination: `${FRONT}/p/a`, alias: 'sum--mer' },
      ],
      ['ttlDays zero', { destination: `${FRONT}/p/a`, ttlDays: 0 }],
      ['ttlDays above 3650', { destination: `${FRONT}/p/a`, ttlDays: 3651 }],
      ['ttlDays not an integer', { destination: `${FRONT}/p/a`, ttlDays: 1.5 }],
    ])('%s', async (_name, body) => {
      const res = await t.create(u1, body);
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('validation_failed');
      expect(res.body.errors?.length).toBeGreaterThan(0);
      expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
    });

    it.each([
      ['missing', undefined],
      ['7 characters', 'abcdefg'],
      ['129 characters', 'k'.repeat(129)],
    ])('Idempotency-Key %s', async (_name, key) => {
      let req = t.as(u1).post('/api/links');
      if (key) req = req.set('Idempotency-Key', key);
      const res = await req.send({ destination: t.destination() });
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('validation_failed');
      expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
    });
  });

  describe('S37 AS-03: destination policy', () => {
    it.each([
      ['http', 'http://shop.example/p/x'],
      ['another host', 'https://evil.example/phish'],
      ['user-info trick', 'https://shop.example@evil.example/x'],
    ])(
      'refuses %s with 422 destination_not_allowed and stores nothing',
      async (_n, destination) => {
        const res = await t.create(u1, { destination });
        expect(res.status).toBe(422);
        expect(problem(res).code).toBe('destination_not_allowed');
        expect(JSON.stringify(res.body)).not.toContain('evil');
        expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
      },
    );

    it('accepts an upper-case host and stores it in lower case', async () => {
      const res = await t.create(u1, {
        destination: 'https://SHOP.example/p/x?a=1#reviews',
      });
      expect(res.status).toBe(201);
      expect((await t.stored(res.body.code))?.destination).toBe(
        'https://shop.example/p/x?a=1#reviews',
      );
    });
  });

  it('S37 AS-04: the ref parameter is removed from the stored destination; order and fragment stay', async () => {
    const res = await t.create(u1, {
      destination: `${FRONT}/p/x?a=1&ref=EVIL&b=2#top`,
    });
    expect(res.status).toBe(201);
    expect((await t.stored(res.body.code))?.destination).toBe(
      `${FRONT}/p/x?a=1&b=2#top`,
    );
  });

  describe('S37 AS-05 / AS-06: codes and number leases', () => {
    const key = () => t.config.get('share_link_code_key');

    it('S37 AS-05: 1,000 concurrent creates through 3 instances give 1,000 distinct codes, all stored', async () => {
      t.config.set('share_link_max_per_owner', 5_000);
      const redis = app(t).get(RedisService);
      const services = [1, 2, 3].map(() =>
        t.commandsWith(new RedisCodeSequence(redis)),
      );
      // First use of each instance (connections, JIT) outlasts the 150 ms store timers; the burst measures the codes.
      for (const service of services)
        await service.create(u1.id, { destination: t.destination('/p/warm') });
      // One Node process plays all three instances: 1,000 requests released at the very same tick starve the 150 ms
      // timers of the stores (the process signs every DynamoDB request on one CPU), so they go out in ten waves of 100.
      const results: PromiseSettledResult<{ code: string }>[] = [];
      for (let wave = 0; wave < 10; wave++)
        results.push(
          ...(await inParallel(100, (i) =>
            services[i % 3].create(u1.id, {
              destination: t.destination(`/p/${wave}-${i}`),
            }),
          )),
        );
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .map((r) =>
            String((r as PromiseRejectedResult).reason?.cause?.cause?.message),
          ),
      ).toEqual([]);
      const codes = results.map(
        (r) => (r as PromiseFulfilledResult<{ code: string }>).value.code,
      );
      expect(new Set(codes).size).toBe(1_000);
      for (const code of codes) expect(code).toMatch(/^[0-9A-Za-z]{7}$/);
      const spot = codes[500];
      expect(await t.stored(spot)).toMatchObject({ ownerId: u1.id });
      expect(key()).toBeTruthy();
    });

    it('S37 AS-06: a block of 1,000 costs one counter call; a stopped instance’s block is never reissued; concurrent demands share one call', async () => {
      const redis = app(t).get(RedisService);
      const incrby = jest.spyOn(redis.client, 'incrby');
      try {
        const sequence = new RedisCodeSequence(redis);
        const handed: number[] = [];
        for (let i = 0; i < 2_500; i++) handed.push(await sequence.next());
        expect(incrby).toHaveBeenCalledTimes(3);
        expect(new Set(handed).size).toBe(2_500);

        // an instance that stops with part of its block unused, then a new one starts
        incrby.mockClear();
        const stopped = new RedisCodeSequence(redis);
        const first = await stopped.next();
        const successor = new RedisCodeSequence(redis);
        const next = await successor.next();
        expect(incrby).toHaveBeenCalledTimes(2);
        expect(next).toBeGreaterThan(first + 999); // the rest of `stopped`'s block is skipped for good

        // five concurrent demands on an exhausted instance
        incrby.mockClear();
        const fresh = new RedisCodeSequence(redis);
        const five = await Promise.all([1, 2, 3, 4, 5].map(() => fresh.next()));
        expect(incrby).toHaveBeenCalledTimes(1);
        expect(new Set(five).size).toBe(5);
      } finally {
        incrby.mockRestore();
      }
    });
  });

  describe('S37 AS-07: a generated code collides with a stored link', () => {
    const codeFor = (n: number) =>
      toBase62(scramble(n, t.config.get('share_link_code_key')));

    it('creates with another code, leaves the planted link untouched and counts the collision', async () => {
      const redis = app(t).get(RedisService);
      await redis.client.set('share-links:id-seq', 5_000_000);
      const service = t.commandsWith(new RedisCodeSequence(redis));
      const planted = await t.plant({
        code: codeFor(5_000_001),
        ownerId: (await t.user()).id,
        destination: `${FRONT}/p/original`,
      });
      const before = MetricsRegistry.value('link_code_collision_total') ?? 0;

      const link = await service.create(u1.id, {
        destination: t.destination(),
      });

      expect(link.code).toBe(codeFor(5_000_002));
      expect(await t.stored(planted.code)).toMatchObject({
        destination: `${FRONT}/p/original`,
        ownerId: planted.ownerId,
      });
      expect(MetricsRegistry.value('link_code_collision_total')).toBe(
        before + 1,
      );
    });

    it('answers 503 code_generation_failed after 5 collisions and writes nothing', async () => {
      const redis = app(t).get(RedisService);
      await redis.client.set('share-links:id-seq', 6_000_000);
      const service = t.commandsWith(new RedisCodeSequence(redis));
      const other = (await t.user()).id;
      for (let n = 6_000_001; n <= 6_000_005; n++)
        await t.plant({ code: codeFor(n), ownerId: other });

      await expect(
        service.create(u1.id, { destination: t.destination() }),
      ).rejects.toMatchObject({ status: 503, code: 'code_generation_failed' });
      expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
    });
  });

  describe('S37 AS-08: a dependency fails during create', () => {
    it.each([
      ['sequence', 'the code counter'],
      ['filter', 'the existence filter'],
      ['repo', 'the link store'],
    ] as const)(
      '%s down (%s) → 503 service_unavailable, nothing stored; the same key succeeds after recovery',
      async (dep, _what) => {
        const key = `retry-${uuidv4()}`;
        t.faults.set(dep, { kind: 'down' });
        const body = { destination: t.destination() };

        const failed = await t.create(u1, body, key);

        expect(failed.status).toBe(503);
        expect(problem(failed).code).toBe('service_unavailable');
        expect(failed.body.detail).not.toMatch(
          /dynamo|redis|link-store|stack/i,
        );
        t.faults.delete(dep);
        expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);

        const retried = await t.create(u1, body, key);
        expect(retried.status).toBe(201);
      },
    );
  });

  describe('S37 AS-09 / AS-10: idempotency', () => {
    it('S37 AS-09: a replay returns the stored answer, keys are per user and a key expires after 24 hours', async () => {
      const u2 = await t.user();
      const body = { destination: t.destination() };
      const key = `key-${uuidv4()}`;

      const first = await t.create(u1, body, key);
      const replay = await t.create(u1, body, key);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect((await t.repository.listByOwner(u1.id, 10)).length).toBe(1);

      const other = await t.create(u2, body, key);
      expect(other.status).toBe(201);
      expect(other.body.code).not.toBe(first.body.code);

      t.clock.advance(25 * 3_600_000);
      await t.reauth(u1);
      const later = await t.create(u1, body, key);
      expect(later.status).toBe(201);
      expect(later.body.code).not.toBe(first.body.code);
    });

    it('S37 AS-10: two simultaneous requests with one key → one 201 and one 409; another body → 422 idempotency_key_reuse', async () => {
      const key = `key-${uuidv4()}`;
      const body = { destination: t.destination() };
      const results = await inParallel(2, () => t.create(u1, body, key));
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        )
        .sort();
      expect(statuses).toEqual([201, 409]);
      expect((await t.repository.listByOwner(u1.id, 10)).length).toBe(1);

      const reused = await t.create(u1, { destination: t.destination() }, key);
      expect(reused.status).toBe(422);
      expect(problem(reused).code).toBe('idempotency_key_reuse');
    });
  });

  it('S37 AS-11: expiry is T + ttlDays; 3650 is accepted; omitted is null', async () => {
    const thirty = await t.create(u1, {
      destination: t.destination(),
      ttlDays: 30,
    });
    expect(thirty.status).toBe(201);
    expect(thirty.body.expiresAt).toBe(
      new Date(t.clock.now().getTime() + 30 * 86_400_000).toISOString(),
    );
    expect(
      (await t.create(u1, { destination: t.destination(), ttlDays: 3650 }))
        .status,
    ).toBe(201);
    const open = await t.create(u1, { destination: t.destination() });
    expect(open.body.expiresAt).toBeNull();
    expect((await t.raw(open.body.code))?.purgeAtEpoch).toBeUndefined();
  });

  describe('S37 AS-12: per-owner limit', () => {
    beforeEach(() => t.config.set('share_link_max_per_owner', 5));

    it('refuses the sixth link with 422 link_limit_reached; another user is unaffected; disabling frees a place', async () => {
      const u2 = await t.user();
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) codes.push(await t.newLink(u1));

      const sixth = await t.create(u1, { destination: t.destination() });
      expect(sixth.status).toBe(422);
      expect(problem(sixth).code).toBe('link_limit_reached');

      expect(
        (await t.create(u2, { destination: t.destination() })).status,
      ).toBe(201);

      await t.as(u1).post(`/api/links/${codes[0]}/disable`).expect(200);
      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(201);
    });

    it('two racing creates at limit − 1 → one 201 and one 422', async () => {
      for (let i = 0; i < 4; i++) await t.newLink(u1);
      const results = await inParallel(2, () =>
        t.create(u1, { destination: t.destination() }),
      );
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        )
        .sort();
      expect(statuses).toEqual([201, 422]);
      expect((await t.repository.listByOwner(u1.id, 10)).length).toBe(5);
    });

    it('links that expired free their places exactly', async () => {
      for (let i = 0; i < 5; i++) await t.newLink(u1, { ttlDays: 1 });
      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(422);
      t.clock.advance(2 * 86_400_000);
      await t.reauth(u1);
      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(201);
    });
  });

  describe('S37 AS-13: rate limit', () => {
    it('the 21st create in a minute answers 429 with Retry-After; the policy is its own, not S25’s', async () => {
      const policy = marketingRatePolicies.policies['share-link.create'];
      expect(policy).toMatchObject({
        limit: 20,
        windowMs: 60_000,
        failMode: 'closed',
      });
      expect(marketingRatePolicies.policies).not.toHaveProperty(
        'discussion.write',
      );

      for (let i = 0; i < 20; i++) await t.newLink(u1);
      const limited = await t.create(u1, { destination: t.destination() });
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await t.repository.listByOwner(u1.id, 100)).length).toBe(20);
    });

    it('a limiter store that is down fails create closed with 503 while the redirect keeps working', async () => {
      const code = await t.newLink(u1);
      t.redisProxy!.mode = 'refuse';
      try {
        const res = await t.create(u1, { destination: t.destination() });
        expect(res.status).toBe(503);
        expect(problem(res).code).toBe('rate_limiter_unavailable');
        expect((await t.follow(code)).status).toBe(302);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      expect((await t.repository.listByOwner(u1.id, 10)).length).toBe(1);
    });
  });

  describe('S37 AS-14: destination reputation hook', () => {
    it('a blocked destination → 422 destination_blocked, nothing stored', async () => {
      t.reputation.verdict = 'block';
      const res = await t.create(u1, { destination: t.destination() });
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('destination_blocked');
      expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
    });

    it('a check that does not answer in 2 s → 503 destination_check_unavailable, nothing stored', async () => {
      t.reputation.verdict = 'hang';
      const res = await t.create(u1, { destination: t.destination() });
      expect(res.status).toBe(503);
      expect(problem(res).code).toBe('destination_check_unavailable');
      expect(res.headers['retry-after']).toBeDefined();
      expect(await t.repository.listByOwner(u1.id, 10)).toEqual([]);
    });

    it('an allowed destination → 201', async () => {
      expect(
        (await t.create(u1, { destination: t.destination() })).status,
      ).toBe(201);
    });
  });

  describe('S37 AS-15: authentication', () => {
    it.each([
      ['POST', '/api/links'],
      ['GET', '/api/links'],
      ['PATCH', '/api/links/abcd1234'],
      ['POST', '/api/links/abcd1234/disable'],
      ['GET', '/api/links/abcd1234/stats'],
    ])('%s %s without credentials → 401', async (method, url) => {
      const res = await t
        .http()
        [method.toLowerCase() as 'get' | 'post' | 'patch'](url)
        .set('Idempotency-Key', uuidv4())
        .send({});
      expect(res.status).toBe(401);
    });

    it('the public redirect is served without credentials', async () => {
      const code = await t.newLink(u1);
      expect((await t.follow(code)).status).toBe(302);
    });
  });

  describe('S37 AS-16: error shape', () => {
    it('a 4xx and a forced 5xx are problem+json with a request id and no internals', async () => {
      const client = await t.create(u1, {
        destination: 'http://shop.example/p',
      });
      expect(client.status).toBe(422);
      expect(problem(client).requestId).toBeTruthy();

      t.faults.set('repo', { kind: 'down' });
      const server = await t.create(u1, { destination: t.destination() });
      expect(server.status).toBe(503);
      expect(problem(server).requestId).toBeTruthy();
      expect(JSON.stringify(server.body)).not.toMatch(
        /stack|at \w+\.|select |dynamo|redis|DependencyUnavailable/i,
      );
    });
  });

  describe('S37 AS-17 – AS-23: custom aliases', () => {
    it('S37 AS-17: a valid alias → 201 kind custom, and the redirect follows it', async () => {
      const alias = t.alias('summer-drop');
      const destination = t.destination('/drops/sneakers');
      const res = await t.create(u1, { destination, alias });
      expect(res.status).toBe(201);
      expect(shortLinkSchema.parse(res.body)).toMatchObject({
        code: alias,
        kind: 'custom',
      });
      const followed = await t.follow(alias);
      expect(followed.status).toBe(302);
      expect(followed.headers.location).toBe(`${destination}?ref=${alias}`);
    });

    it('S37 AS-18: a valid alias is created and an invalid one is a 400 through the API', async () => {
      expect(
        (await t.create(u1, { destination: t.destination(), alias: t.alias() }))
          .status,
      ).toBe(201);
      const bad = await t.create(u1, {
        destination: t.destination(),
        alias: '-bad-alias-',
      });
      expect(bad.status).toBe(400);
      expect(problem(bad).code).toBe('validation_failed');
    });

    it.each(['admin', 'login', 'status'])(
      'S37 AS-19: reserved alias %s → 422 alias_reserved, nothing stored',
      async (alias) => {
        const res = await t.create(u1, { destination: t.destination(), alias });
        expect(res.status).toBe(422);
        expect(problem(res).code).toBe('alias_reserved');
        expect(await t.stored(alias)).toBeNull();
      },
    );

    it('S37 AS-19: the configured reserved list extends the built-in one', async () => {
      t.config.set('share_link_reserved_aliases', 'summer-sale, beta');
      const res = await t.create(u1, {
        destination: t.destination(),
        alias: 'summer-sale',
      });
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('alias_reserved');
    });

    it('S37 AS-20: a taken alias → 409 alias_taken, the original untouched; the owner cannot reclaim it either', async () => {
      const u2 = await t.user();
      const alias = t.alias();
      const original = t.destination('/p/original');
      expect(
        (await t.create(u1, { destination: original, alias })).status,
      ).toBe(201);

      const taken = await t.create(u2, { destination: t.destination(), alias });
      expect(taken.status).toBe(409);
      expect(problem(taken).code).toBe('alias_taken');
      const again = await t.create(u1, { destination: t.destination(), alias });
      expect(again.status).toBe(409);
      expect(await t.stored(alias)).toMatchObject({
        ownerId: u1.id,
        destination: original,
      });
    });

    it('S37 AS-21: ten simultaneous claims → one 201, nine 409, one row, and the redirect goes to the winner', async () => {
      const alias = t.alias();
      const users = await Promise.all(
        Array.from({ length: 10 }, () => t.user()),
      );
      const destinations = users.map((_, i) => t.destination(`/claim/${i}`));
      const results = await inParallel(10, (i) =>
        t.create(users[i], { destination: destinations[i], alias }),
      );
      const responses = results.map(
        (r) =>
          (r as PromiseFulfilledResult<{ status: number; body: any }>).value,
      );
      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
      const winner = responses.findIndex((r) => r.status === 201);
      expect(await t.stored(alias)).toMatchObject({
        ownerId: users[winner].id,
      });
      expect((await t.follow(alias)).headers.location).toBe(
        `${destinations[winner]}?ref=${alias}`,
      );
    });

    it('S37 AS-22: an expired or disabled alias stays taken for 13 months; after the purge it can be claimed again', async () => {
      const u2 = await t.user();
      const expiring = t.alias('old-promo');
      const disabled = t.alias('gone-promo');
      await t.create(u1, {
        destination: t.destination(),
        alias: expiring,
        ttlDays: 1,
      });
      await t.create(u1, { destination: t.destination(), alias: disabled });
      await t.as(u1).post(`/api/links/${disabled}/disable`).expect(200);
      t.clock.advance(2 * 86_400_000);
      await t.reauth(u2);

      for (const alias of [expiring, disabled]) {
        const res = await t.create(u2, { destination: t.destination(), alias });
        expect(res.status).toBe(409);
      }

      // the record carries its purge time: 13 months after expiry / disable
      const expiry = Date.parse((await t.raw(expiring))!.expiresAt);
      const purgeAt = new Date(expiry);
      purgeAt.setUTCMonth(purgeAt.getUTCMonth() + 13);
      expect((await t.raw(expiring))!.purgeAtEpoch).toBe(
        Math.floor(purgeAt.getTime() / 1000),
      );
      expect(typeof (await t.raw(disabled))!.purgeAtEpoch).toBe('number');

      await t.purge(expiring);
      t.clock.advance(14 * 31 * 86_400_000);
      await t.reauth(u2);
      expect(
        (await t.create(u2, { destination: t.destination(), alias: expiring }))
          .status,
      ).toBe(201);
    });
  });
});

/** The Nest application behind the fixture. */
const app = (t: ShareLinksTestApp) => t.app;
