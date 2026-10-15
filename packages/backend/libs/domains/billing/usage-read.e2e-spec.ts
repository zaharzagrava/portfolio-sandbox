import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  problemDetailsSchema,
  usageSummarySchema,
} from '@marketplace-sandbox/contracts';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { TestUser } from '@app/test/utils/catalog-app';
import { UsageRecorded } from './application/events/usage-events';
import { USAGE_STORE, type UsageStorePort } from './domain/ports';
import { UsageRecordedConsumer } from './infra/usage.consumers';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { applyS18Plans, seedSubscription } from './testing/billing-seed';

const NOW = '2026-04-10T12:00:00.000Z';

describe('Billing: usage read', () => {
  let t: BillingTestApp;
  let store: UsageStorePort;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true, structuredLogger: true });
    store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
    clickhouse = t.app.get(ClickHouseService, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await applyS18Plans(t);
    t.clock.set(new Date(NOW));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const usage = (
    subjectId: string,
    metric: string,
    quantity: number,
    ts = '2026-04-09T10:00:00.000Z',
  ) =>
    store.insert(
      [{ identity: uuidv4(), subjectId, metric, quantity, ts: new Date(ts) }],
      new Date(ts),
    );
  const get = (user: TestUser, url: string) => t.as(user).get(url);
  /** Shop `a` of DS-1: pro, owner Ann and viewer Vic, with April usage. */
  async function shopA() {
    const { shopId, owner } = await t.shopWithOwner();
    await seedSubscription(t, {
      subjectType: 'SHOP',
      subjectId: shopId,
      plan: 'pro',
      version: 3,
    });
    const vic = await t.member(shopId, 'VIEWER');
    await usage(shopId, 'api.calls', 12_500);
    await usage(shopId, 'llm.assistant.tokens', 300_000);
    return { shopId, ann: owner, vic };
  }

  describe('S18 AS-49 / AS-50: the summary and the month', () => {
    it('S18 AS-49: a member reads the month with used, limit and remaining per metric, sorted by name', async () => {
      const a = await shopA();
      await usage(a.shopId, 'llm.rag.tokens', 40); // a metric no plan limit covers
      await usage(uuidv4(), 'api.calls', 999_999); // another subject: never included

      const res = await get(a.ann, `/api/shops/${a.shopId}/usage`);

      expect(res.status).toBe(200);
      const summary = usageSummarySchema.parse(res.body);
      expect(summary).toEqual({
        month: '2026-04',
        periodStart: '2026-04-01T00:00:00.000Z',
        periodEnd: '2026-05-01T00:00:00.000Z',
        asOf: NOW,
        metrics: [
          {
            metric: 'api.calls',
            used: 12_500,
            limit: 1_000_000,
            remaining: 987_500,
          },
          {
            metric: 'llm.assistant.tokens',
            used: 300_000,
            limit: 5_000_000,
            remaining: 4_700_000,
          },
          { metric: 'llm.rag.tokens', used: 40, limit: null, remaining: null },
        ],
      });
    });

    it('S18 AS-49: every quota-mapped metric is present with zero usage; remaining never goes below zero', async () => {
      const { shopId, owner } = await t.shopWithOwner();
      await usage(shopId, 'api.calls', 1_500); // the free tier allows 1,000
      const summary = usageSummarySchema.parse(
        (await get(owner, `/api/shops/${shopId}/usage`)).body,
      );
      expect(summary.metrics).toEqual([
        { metric: 'api.calls', used: 1_500, limit: 1_000, remaining: 0 },
        { metric: 'llm.assistant.tokens', used: 0, limit: 0, remaining: 0 },
      ]);
    });

    it('S18 AS-50: ?month reads that month; the current month and 12 months back are the edges', async () => {
      const a = await shopA();
      await usage(a.shopId, 'api.calls', 7, '2026-03-15T10:00:00.000Z');
      const march = usageSummarySchema.parse(
        (await get(a.ann, `/api/shops/${a.shopId}/usage?month=2026-03`)).body,
      );
      expect(march).toMatchObject({
        month: '2026-03',
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
      });
      expect(march.metrics.find((m) => m.metric === 'api.calls')?.used).toBe(7);
      for (const ok of ['2026-04', '2025-04'])
        expect(
          (await get(a.ann, `/api/shops/${a.shopId}/usage?month=${ok}`)).status,
        ).toBe(200);
    });

    it.each([
      '2026-05',
      '2025-03',
      '2026-4',
      'abc',
      '2026-13',
      '2026-00',
      '',
      '20260401',
    ])(
      'S18 AS-50: ?month=%j is 400 validation_failed and nothing is read',
      async (month) => {
        const a = await shopA();
        const spy = jest.spyOn(clickhouse, 'query');
        const res = await get(
          a.ann,
          `/api/shops/${a.shopId}/usage?month=${month}`,
        );
        expect(res.status).toBe(400);
        expect(problemDetailsSchema.parse(res.body).code).toBe(
          'validation_failed',
        );
        expect(spy).not.toHaveBeenCalled();
      },
    );
  });

  describe('S18 AS-51 / AS-52: who may read', () => {
    it('S18 AS-51: shop.read is enough (the viewer), a non-member gets the same 404 as for an unknown shop, no credentials get 401', async () => {
      const a = await shopA();
      const bo = await t.shopWithOwner();
      expect((await get(a.vic, `/api/shops/${a.shopId}/usage`)).status).toBe(
        200,
      );

      const strip = (body: Record<string, unknown>) => ({
        ...body,
        instance: '',
        requestId: '',
        traceId: '',
      });
      const unknown = await get(bo.owner, `/api/shops/${uuidv4()}/usage`);
      expect(unknown.status).toBe(404);
      // SC-007: the matrix of every shape the route takes answers one body and reads nothing
      const spy = jest.spyOn(clickhouse, 'query');
      for (const query of [
        '',
        '?month=2026-03',
        '?month=2026-05',
        '?month=abc',
        '?subject=x',
      ]) {
        const foreign = await get(
          bo.owner,
          `/api/shops/${a.shopId}/usage${query}`,
        );
        expect(foreign.status).toBe(404);
        expect(strip(foreign.body)).toEqual(strip(unknown.body));
      }
      expect(spy).not.toHaveBeenCalled();

      expect((await t.http().get(`/api/shops/${a.shopId}/usage`)).status).toBe(
        401,
      );
      expect((await t.http().get('/api/me/usage')).status).toBe(401);
    });

    it('S18 AS-52: a buyer reads only their own usage; the route takes no subject', async () => {
      const u = await t.newUser();
      await seedSubscription(t, {
        subjectType: 'USER',
        subjectId: u.id,
        plan: 'plus',
      });
      await usage(u.id, 'llm.assistant.tokens', 1_830);
      const other = await t.newUser();
      await usage(other.id, 'llm.assistant.tokens', 77_777);

      const own = usageSummarySchema.parse(
        (await get(u, '/api/me/usage')).body,
      );
      expect(own.metrics).toEqual([
        { metric: 'api.calls', used: 0, limit: 0, remaining: 0 },
        {
          metric: 'llm.assistant.tokens',
          used: 1_830,
          limit: 2_000_000,
          remaining: 1_998_170,
        },
      ]);
      // naming another user changes nothing
      const named = await get(
        u,
        `/api/me/usage?userId=${other.id}&subjectId=${other.id}`,
      );
      expect(usageSummarySchema.parse(named.body).metrics).toEqual(own.metrics);
    });
  });

  describe('S18 AS-53: the rate limit', () => {
    it('S18 AS-53: the 61st read within a minute is 429 with Retry-After', async () => {
      const a = await shopA();
      for (let i = 0; i < 60; i++)
        expect((await get(a.ann, `/api/shops/${a.shopId}/usage`)).status).toBe(
          200,
        );
      const refused = await get(a.ann, `/api/shops/${a.shopId}/usage`);
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBeDefined();
      expect(problemDetailsSchema.parse(refused.body).status).toBe(429);
    });
  });

  describe('S18 AS-54 / AS-55: the store down, and freshness', () => {
    it('S18 AS-54: a failing usage store answers 503 usage_unavailable with a generic detail and no store message in the body or the logs (VII.9)', async () => {
      const a = await shopA();
      const secret =
        'SELECT secret_column FROM usage_events WHERE token = hunter2';
      jest.spyOn(clickhouse, 'query').mockRejectedValue(new Error(secret));

      for (const url of [`/api/shops/${a.shopId}/usage`, '/api/me/usage']) {
        const res = await get(a.ann, url);
        expect(res.status).toBe(503);
        const problem = problemDetailsSchema.parse(res.body);
        expect(problem.code).toBe('usage_unavailable');
        // the platform replaces the detail of a 5xx with its generic sentence (V.3)
        expect(problem.detail).toBe(
          'The server could not complete the request. Please try again later.',
        );
        expect(JSON.stringify(res.body)).not.toMatch(
          /hunter2|secret_column|usage_events|stack/i,
        );
        expect(res.body).not.toHaveProperty('metrics');
      }
      expect(t.rawLogs()).not.toMatch(/hunter2|secret_column/);
    });

    it('S18 AS-55: an event processed at T is in the read at T + 30 s, once, duplicates collapsed', async () => {
      const a = await shopA();
      const deliver = t.deliver(UsageRecordedConsumer);
      const event = {
        ...UsageRecorded.create(a.shopId, 0, {
          metric: 'api.calls',
          quantity: 500,
          ts: '2026-04-10T11:59:00.000Z',
        }),
        eventId: uuidv7(),
      };
      const before = usageSummarySchema.parse(
        (await get(a.ann, `/api/shops/${a.shopId}/usage`)).body,
      );
      await deliver.deliver(event, event);
      t.clock.advance(30_000);
      await t.reauth(a.ann);
      const after = usageSummarySchema.parse(
        (await get(a.ann, `/api/shops/${a.shopId}/usage`)).body,
      );
      const calls = (s: typeof before) =>
        s.metrics.find((m) => m.metric === 'api.calls')!.used;
      expect(calls(after)).toBe(calls(before) + 500);
      expect(after.asOf).toBe('2026-04-10T12:00:30.000Z');
    });
  });

  // Last in the file: it boots a second app, with the limiter store behind a proxy, and closing it ends the shared
  // database connection of this process.
  it('S18 AS-53: with the limiter store down the read is refused (fail closed) and nothing is read', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createBillingApp({
      realUsage: true,
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await own.reset();
      const { shopId, owner } = await own.shopWithOwner();
      const spy = jest.spyOn(
        own.app.get(ClickHouseService, { strict: false }),
        'query',
      );
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const res = await own.as(owner).get(`/api/shops/${shopId}/usage`);
      expect(res.status).toBe(503);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 120_000);
});
