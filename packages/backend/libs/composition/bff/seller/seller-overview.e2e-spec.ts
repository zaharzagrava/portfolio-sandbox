import { randomUUID } from 'node:crypto';
import {
  problemDetailsSchema,
  sellerOverviewResponseSchema,
} from '@marketplace-sandbox/contracts';
import { createBffApp, BffTestApp, resetBffRedis } from '../testing/app-factory';
import { signIn } from '../testing/helpers';
import { StubUpstream } from '../testing/stub-upstream';
import { BreakerRegistry } from '../upstream/breaker-registry';

const SHOP_ID = randomUUID();

const shopBody = (id = SHOP_ID) => ({
  id,
  name: 'Lamps',
  slug: 'lamps',
  plan: 'STARTER',
  status: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  payoutsEnabled: true,
  region: 'eu',
  shopVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  purgeAt: null,
  myRole: 'OWNER',
  myPermissions: ['shop.read'],
});
const statsBody = (days = 30) => ({
  shopId: SHOP_ID,
  days,
  from: '2026-09-18',
  to: '2026-10-17',
  currency: 'USD',
  summary: {
    revenueMinor: 1000,
    orders: 2,
    unitsSold: 3,
    uniqueBuyers: 2,
    refundsCount: 0,
    refundedMinor: 0,
    netRevenueMinor: 1000,
    avgOrderValueMinor: 500,
  },
  daily: [],
  topProducts: [],
});
const todayBody = {
  day: '2026-10-17',
  totals: { orders: 1, units: 1, revenueMinor: 500 },
  series: [],
};
const rankBody = {
  period: {
    kind: 'week',
    id: '2026-W42',
    startsAt: '2026-10-12T00:00:00.000Z',
    endsAt: '2026-10-19T00:00:00.000Z',
    closed: false,
  },
  category: null,
  rank: 3,
  of: 40,
  topPercent: 8,
  revenueMinor: 1000,
};
const problem = (status: number, code: string) => ({
  type: 'https://errors.test/' + code,
  title: 'Stub problem',
  status,
  detail: 'stub says no',
  instance: '/',
  code,
  requestId: randomUUID(),
});

describe('W04 seller overview aggregate (GET /bff/seller/:shopId/overview)', () => {
  let stub: StubUpstream;
  let ctx: BffTestApp;

  beforeAll(async () => {
    stub = await StubUpstream.start();
    ctx = await createBffApp({ upstreamUrl: stub.url });
  });
  afterAll(async () => {
    await ctx.close();
    await stub.close();
  });
  beforeEach(async () => {
    stub.reset();
    ctx.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
    stub.respond('sellerShop', { body: shopBody() });
    stub.respond('sellerStats', (call) => ({
      body: statsBody(Number(call.query.days)),
    }));
    stub.respond('sellerToday', { body: todayBody });
    stub.respond('sellerRank', { body: rankBody });
  });

  const overview = (id: string = SHOP_ID, query = '') =>
    ctx.http().get(`/api/bff/seller/${id}/overview${query}`);
  const parseProblem = (body: unknown) => problemDetailsSchema.parse(body);

  it('W04 B-1: happy path returns the shop, all three sections, no errors, no-store and no Set-Cookie', async () => {
    const who = await signIn(ctx, stub, { accessToken: 'access-of-S' });
    stub.calls.length = 0;
    const res = await overview().set('Cookie', who.cookie).expect(200);
    const body = sellerOverviewResponseSchema.parse(res.body);
    expect(body.shop.id).toBe(SHOP_ID);
    expect(body.stats?.days).toBe(30);
    expect(body.today).toEqual(todayBody);
    expect(body.rank).toEqual(rankBody);
    expect(body.errors).toEqual([]);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    for (const route of [
      'sellerShop',
      'sellerStats',
      'sellerToday',
      'sellerRank',
    ] as const)
      expect(stub.callsTo(route)[0].headers.authorization).toBe(
        'Bearer access-of-S',
      );
    expect(stub.callsTo('sellerStats')[0].query).toEqual({ days: '30' });
  });

  it('W04 B-1: days=7|90 is passed upstream', async () => {
    const who = await signIn(ctx, stub);
    for (const days of [7, 90]) {
      stub.calls.length = 0;
      const res = await overview(SHOP_ID, `?days=${days}`)
        .set('Cookie', who.cookie)
        .expect(200);
      expect(sellerOverviewResponseSchema.parse(res.body).stats?.days).toBe(
        days,
      );
      expect(stub.callsTo('sellerStats')[0].query).toEqual({
        days: String(days),
      });
    }
  });

  it.each(['0', '366', 'abc', '15'])(
    'W04 B-1: days=%s is 400 validation_failed and nothing is called',
    async (days) => {
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const res = await overview(SHOP_ID, `?days=${days}`)
        .set('Cookie', who.cookie)
        .expect(400);
      expect(parseProblem(res.body).code).toBe('validation_failed');
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('W04 B-1: a malformed shop id is 400 and nothing is called', async () => {
    const who = await signIn(ctx, stub);
    stub.calls.length = 0;
    const res = await overview('not-a-uuid').set('Cookie', who.cookie).expect(400);
    expect(parseProblem(res.body).code).toBe('validation_failed');
    expect(stub.calls).toHaveLength(0);
  });

  it('W04 B-1: no credentials is 401 and nothing is called', async () => {
    const res = await overview().expect(401);
    expect(parseProblem(res.body).code).toBe('unauthenticated');
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    ['unknown', 404],
    ['non-member (403)', 403],
  ])(
    'W04 B-1: a %s shop is the same 404 shop_not_found and no section is read',
    async (_name, status) => {
      stub.respond('sellerShop', {
        status,
        body: problem(status, status === 404 ? 'shop_not_found' : 'forbidden'),
      });
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const res = await overview().set('Cookie', who.cookie).expect(404);
      expect(parseProblem(res.body).code).toBe('shop_not_found');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stub.callsTo('sellerStats')).toHaveLength(0);
      expect(stub.callsTo('sellerToday')).toHaveLength(0);
      expect(stub.callsTo('sellerRank')).toHaveLength(0);
    },
  );

  it('W04 B-1: the shop read failing is 503 upstream_unavailable', async () => {
    stub.respond('sellerShop', { status: 503 });
    const who = await signIn(ctx, stub);
    const res = await overview().set('Cookie', who.cookie).expect(503);
    expect(parseProblem(res.body).code).toBe('upstream_unavailable');
  });

  it('W04 B-1: an upstream 401 on the shop read rejects the credential', async () => {
    stub.respond('sellerShop', { status: 401 });
    const who = await signIn(ctx, stub);
    const res = await overview().set('Cookie', who.cookie).expect(401);
    expect(parseProblem(res.body).code).toBe('invalid_token');
  });

  it.each([
    ['stats', 'sellerStats'],
    ['today', 'sellerToday'],
    ['rank', 'sellerRank'],
  ] as const)(
    'W04 B-1: %s failing alone leaves the other sections intact with an errors entry',
    async (section, route) => {
      stub.respond(route, { status: 503 });
      const who = await signIn(ctx, stub);
      const body = sellerOverviewResponseSchema.parse(
        (await overview().set('Cookie', who.cookie).expect(200)).body,
      );
      expect(body.errors).toEqual([
        { section, code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ]);
      expect(body[section]).toBeNull();
      for (const other of ['stats', 'today', 'rank'] as const)
        if (other !== section) expect(body[other]).not.toBeNull();
    },
  );

  it('W04 B-1: a section answering with an invalid body is null plus an UPSTREAM_INVALID entry', async () => {
    stub.respond('sellerToday', { body: { nope: true } });
    const who = await signIn(ctx, stub);
    const body = sellerOverviewResponseSchema.parse(
      (await overview().set('Cookie', who.cookie).expect(200)).body,
    );
    expect(body.today).toBeNull();
    expect(body.errors).toEqual([
      { section: 'today', code: 'UPSTREAM_INVALID', retryable: false },
    ]);
  });

  it('W04 B-1: upstream 404 not_ranked is rank {notRanked: true} and no error', async () => {
    stub.respond('sellerRank', {
      status: 404,
      body: problem(404, 'not_ranked'),
    });
    const who = await signIn(ctx, stub);
    const body = sellerOverviewResponseSchema.parse(
      (await overview().set('Cookie', who.cookie).expect(200)).body,
    );
    expect(body.rank).toEqual({ notRanked: true });
    expect(body.errors).toEqual([]);
  });

  it('W04 B-1: the 301st request of a principal in a minute is 429', async () => {
    const limited = await createBffApp({
      upstreamUrl: stub.url,
      env: { TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1' },
    });
    try {
      await resetBffRedis(limited.redis);
      const as = (ip: string) =>
        limited
          .http()
          .get('/api/bff/seller/not-a-uuid/overview')
          .set('X-Forwarded-For', ip);
      for (let i = 0; i < 300; i++) await as('198.51.100.7').expect(400);
      const denied = await as('198.51.100.7').expect(429);
      expect(parseProblem(denied.body).code).toBe('rate_limited');
      expect(denied.headers['ratelimit-policy']).toContain(
        'bff.seller-overview.principal',
      );
      await as('198.51.100.8').expect(400);
    } finally {
      await limited.close();
    }
  });
});
