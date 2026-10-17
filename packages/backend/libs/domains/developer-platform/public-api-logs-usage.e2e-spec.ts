import { requestLogPageSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import {
  addShopMember,
  createKey,
  createPublicApiKit,
  newId,
  outboxEvents,
  rows,
  waitFor,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';
import { ApiRequestsProjector } from './infra/api-requests.projector';
import { PublicApiUsageMeteringConsumer } from './infra/consumers';
import { requestLoggedEnvelope } from './infra/kafka-request-record.publisher';
import { PublicApiProjectorModule } from './public-api-projector.module';
import { PublicCatalogService } from './application/public-catalog.service';
import { UsageCloser } from './application/usage.closer';
import { RequestRecord } from './domain/ports';
import { recordEventId } from './domain/request-record';
import { usageEventId } from './domain/usage-bucket';

const LOGS = (shopId: string) => `/api/shops/${shopId}/developers/logs`;
const USAGE = (shopId: string) => `/api/shops/${shopId}/developers/usage`;
const limiterPolicy = developerPlatformRatePolicies.policies[
  'public-api.default'
] as {
  limit: number;
  localLeaseFraction?: number;
};

const record = (
  shopId: string,
  over: Partial<RequestRecord> = {},
): RequestRecord => ({
  requestId: `req_${newId().replace(/-/g, '')}`,
  shopId,
  keyId: 'key-1',
  livemode: true,
  version: '2026-10-01',
  method: 'GET',
  route: '/v1/products',
  status: 200,
  durationMs: 4,
  deprecated: false,
  idempotentReplay: false,
  cost: 1,
  occurredAt: new Date('2026-10-06T12:00:30.000Z'),
  ...over,
});

describe('Public API: request logs and usage report', () => {
  let t: PublicApiKit;
  let pub: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit({
      dashboardImports: [PublicApiProjectorModule],
    });
    pub = t.pub;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (): Promise<{
    w: ShopWorld;
    key: CreatedKey;
    test: CreatedKey;
  }> => {
    const w = await t.seedWorld();
    return {
      w,
      key: await createKey(t, w, { name: 'live' }),
      test: await createKey(t, w, { name: 'test', livemode: false }),
    };
  };
  const projector = () => t.app.get(ApiRequestsProjector);
  const project = (records: RequestRecord[]) =>
    projector().project(records.map(requestLoggedEnvelope));
  const sent = async () => {
    await t.flushRecords();
    return t.records.records;
  };
  const only = async (requestId: string): Promise<RequestRecord> => {
    await t.flushRecords();
    const found = t.records.of(requestId);
    expect(found).toHaveLength(1);
    return found[0];
  };

  describe('AS-58, AS-59 one record per authenticated call, request ids', () => {
    it('S42 AS-58: every authenticated answer leaves exactly one record built from what was sent: 200, 404, 403, 429, 5xx and 410', async () => {
      const { w, key } = await world();
      const readOnly = await createKey(t, w, { scopes: ['orders:read'] });
      const created = await pub
        .withKey(key.key)
        .post('/v1/products')
        .set('Idempotency-Key', newId())
        .send({
          title: 'Mug',
          price: { amount: 100, currency: 'USD' },
          stock: 1,
          category: 'c',
          brand: 'b',
        })
        .expect(201);
      const id = created.body.id as string;

      const answers: Array<
        [
          string,
          { status: number; headers: Record<string, string> },
          string,
          string | undefined,
        ]
      > = [];
      answers.push([
        'ok',
        await pub.withKey(key.key).get(`/v1/products/${id}?x=secret-query`),
        '/v1/products/:id',
        undefined,
      ]);
      answers.push([
        'missing',
        await pub.withKey(key.key).get(`/v1/products/${newId()}`),
        '/v1/products/:id',
        'resource_missing',
      ]);
      answers.push([
        'scope',
        await pub.withKey(readOnly.key).get('/v1/products'),
        '/v1/products',
        'insufficient_scope',
      ]);
      const catalog = pub.app.get(PublicCatalogService);
      const spy = jest
        .spyOn(catalog, 'list')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        answers.push([
          'error',
          await pub.withKey(key.key).get('/v1/products'),
          '/v1/products',
          'internal_error',
        ]);
      } finally {
        spy.mockRestore();
      }
      t.clock.set(new Date('2027-04-01T00:00:00.000Z'));
      answers.push([
        'gone',
        await pub.withKey(key.key).get(`/v1/products/${id}/stock`),
        '/v1/products/:id/stock',
        'endpoint_retired',
      ]);
      t.clock.set(new Date('2026-10-06T12:00:00.000Z'));
      limiterPolicy.limit = 1;
      limiterPolicy.localLeaseFraction = undefined;
      try {
        await pub.withKey(key.key).get('/v1/products');
        answers.push([
          'limited',
          await pub.withKey(key.key).get('/v1/products'),
          '/v1/products',
          'rate_limited',
        ]);
      } finally {
        limiterPolicy.limit = 6000;
        limiterPolicy.localLeaseFraction = 0.05;
      }

      await t.flushRecords();
      for (const [label, res, route, errorCode] of answers) {
        const requestId = res.headers['request-id'];
        const rec = t.records.of(requestId);
        expect({ label, n: rec.length }).toEqual({ label, n: 1 });
        expect(rec[0]).toMatchObject({
          shopId: w.shop.id,
          keyId: key.id === rec[0].keyId ? key.id : readOnly.id,
          route,
          status: res.status,
          idempotentReplay: false,
        });
        expect(rec[0].errorCode).toBe(errorCode);
        expect(Number.isInteger(rec[0].durationMs)).toBe(true);
      }
      const gone = answers.find(([l]) => l === 'gone')![1];
      expect(t.records.of(gone.headers['request-id'])[0].deprecated).toBe(true);
    });

    it('S42 AS-58: the record carries no path id, query string, header, body, key or address', async () => {
      const { key } = await world();
      const res = await pub
        .withKey(key.key)
        .get(`/v1/products/${newId()}?limit=7&secret=abc`)
        .set('X-Custom-Header', 'private-value')
        .expect(404);
      const rec = await only(res.headers['request-id']);
      const wire = JSON.stringify(rec);
      for (const forbidden of [
        'limit=7',
        'secret=abc',
        'private-value',
        key.key,
        key.key.split('_')[3],
        'Authorization',
        '127.0.0.1',
        'localhost',
      ])
        expect(wire).not.toContain(forbidden);
      expect(rec.route).toBe('/v1/products/:id');
      expect(Object.keys(rec).sort()).toEqual(
        [
          'cost',
          'deprecated',
          'durationMs',
          'errorCode',
          'idempotentReplay',
          'keyId',
          'livemode',
          'method',
          'occurredAt',
          'requestId',
          'route',
          'shopId',
          'status',
          'version',
        ].sort(),
      );
    });

    it('S42 AS-58: test-key calls carry the live shop and livemode false; an unauthenticated call leaves no record', async () => {
      const { w, test } = await world();
      const ok = await pub.withKey(test.key).get('/v1/products').expect(200);
      await pub.http().get('/v1/products').expect(401);
      await pub.withKey('sk_live_nope').get('/v1/products').expect(401);
      const rec = await only(ok.headers['request-id']);
      expect(rec).toMatchObject({ shopId: w.shop.id, livemode: false });
      expect((await sent()).filter((r) => r.keyId !== test.id)).toHaveLength(0);
    });

    it('S42 AS-58: a replayed create is flagged, a batch reports its size, a deprecated version is flagged', async () => {
      const { key } = await world();
      const body = {
        title: 'Mug',
        price: { amount: 100, currency: 'USD' },
        stock: 1,
        category: 'c',
        brand: 'b',
      };
      const idem = newId();
      const first = await pub
        .withKey(key.key)
        .post('/v1/products')
        .set('Idempotency-Key', idem)
        .send(body)
        .expect(201);
      const again = await pub
        .withKey(key.key)
        .post('/v1/products')
        .set('Idempotency-Key', idem)
        .send(body)
        .expect(201);
      const batch = await pub
        .withKey(key.key)
        .post('/v1/batch')
        .set('Idempotency-Key', newId())
        .send({
          operations: Array.from({ length: 3 }, () => ({
            method: 'GET',
            path: '/v1/products',
          })),
        })
        .expect(200);
      const old = await pub
        .withKey(key.key)
        .get('/v1/products')
        .set('Marketplace-Version', '2026-01-15')
        .expect(200);
      const recs = {
        first: await only(first.headers['request-id']),
        again: await only(again.headers['request-id']),
        batch: await only(batch.headers['request-id']),
        old: await only(old.headers['request-id']),
      };
      expect([
        recs.first.idempotentReplay,
        recs.again.idempotentReplay,
      ]).toEqual([false, true]);
      expect(recs.batch).toMatchObject({ batchOps: 3, cost: 3 });
      expect(recs.old).toMatchObject({
        deprecated: true,
        version: '2026-01-15',
      });
      expect(recs.first.deprecated).toBe(false);
    });

    it('S42 AS-59: every answer carries a unique, server-generated Request-Id; a valid X-Request-Id is echoed and stored, an invalid one ignored; the problem body names the same id', async () => {
      const { key } = await world();
      const answers = [
        await pub.withKey(key.key).get('/v1/products'),
        await pub.withKey(key.key).get(`/v1/products/${newId()}`),
        await pub.http().get('/v1/products'),
        await pub.http().get('/v1/not-a-route'),
        await pub
          .withKey(key.key)
          .get('/v1/products')
          .set('Marketplace-Version', 'nope'),
      ];
      const ids = answers.map((r) => r.headers['request-id']);
      for (const id of ids) expect(id).toMatch(/^req_[0-9a-f]{32}$/);
      expect(new Set(ids).size).toBe(ids.length);
      for (const r of answers.filter((a) => a.status >= 400)) {
        expect(r.body.requestId).toBe(r.headers['request-id']);
      }

      const echoed = await pub
        .withKey(key.key)
        .get('/v1/products')
        .set('X-Request-Id', 'erp-123')
        .expect(200);
      expect(echoed.headers['x-client-request-id']).toBe('erp-123');
      expect(echoed.headers['request-id']).not.toBe('erp-123');
      expect((await only(echoed.headers['request-id'])).clientRequestId).toBe(
        'erp-123',
      );
      for (const bad of ['has space', 'x'.repeat(65), 'semi;colon']) {
        const res = await pub
          .withKey(key.key)
          .get('/v1/products')
          .set('X-Request-Id', bad)
          .expect(200);
        expect(res.headers['x-client-request-id']).toBeUndefined();
      }
    });
  });

  describe('AS-61 logging never hurts the request', () => {
    it('S42 AS-61: with the event bus down calls answer normally; the records arrive once each after recovery', async () => {
      const { key } = await world();
      t.records.down = true;
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const started = Date.now();
        const res = await pub.withKey(key.key).get('/v1/products').expect(200);
        expect(Date.now() - started).toBeLessThan(5_000);
        ids.push(res.headers['request-id']);
      }
      expect(t.records.records).toHaveLength(0);
      t.records.down = false;
      await waitFor(async () => {
        await t.flushRecords();
        return t.records.records.length >= 5;
      }, 'the buffered records');
      for (const id of ids) expect(t.records.of(id)).toHaveLength(1);
    });
  });

  describe('AS-60 search the logs', () => {
    it('S42 AS-60: a record is found by its request id with every field; another shop’s id is an empty page', async () => {
      const a = await world();
      const b = await world();
      const mine = record(a.w.shop.id, {
        clientRequestId: 'erp-9',
        errorCode: 'resource_missing',
        status: 404,
        route: '/v1/products/:id',
        occurredAt: new Date('2026-10-06T11:59:30.000Z'),
      });
      const theirs = record(b.w.shop.id);
      await project([mine, theirs, record(a.w.shop.id), record(a.w.shop.id)]);

      const res = await t
        .as(a.w.owner)
        .get(`${LOGS(a.w.shop.id)}?requestId=${mine.requestId}`)
        .expect(200);
      expect(res.body.items).toEqual([
        {
          requestId: mine.requestId,
          clientRequestId: 'erp-9',
          keyId: 'key-1',
          livemode: true,
          version: '2026-10-01',
          method: 'GET',
          route: '/v1/products/:id',
          status: 404,
          durationMs: 4,
          deprecated: false,
          errorCode: 'resource_missing',
          batchOps: 0,
          idempotentReplay: false,
          at: '2026-10-06T11:59:30.000Z',
        },
      ]);
      const foreign = await t
        .as(a.w.owner)
        .get(`${LOGS(a.w.shop.id)}?requestId=${theirs.requestId}`)
        .expect(200);
      expect(foreign.body).toEqual({ items: [], nextCursor: null });
    });

    it('S42 AS-60: status, route, key and mode filters, newest first with a cursor and a unique tiebreaker', async () => {
      const { w } = await world();
      const at = (s: number) =>
        new Date(Date.parse('2026-10-06T11:00:00.000Z') + s * 1_000);
      await project([
        record(w.shop.id, { status: 200, occurredAt: at(1) }),
        record(w.shop.id, {
          status: 404,
          route: '/v1/products/:id',
          occurredAt: at(2),
        }),
        record(w.shop.id, { status: 429, keyId: 'key-2', occurredAt: at(3) }),
        record(w.shop.id, { status: 500, livemode: false, occurredAt: at(4) }),
        record(w.shop.id, { status: 200, occurredAt: at(5) }),
        record(w.shop.id, { status: 200, occurredAt: at(5) }), // the same instant: the request id breaks the tie
      ]);
      const get = (q: string) =>
        t
          .as(w.owner)
          .get(`${LOGS(w.shop.id)}?${q}`)
          .expect(200)
          .then((r) => r.body);
      expect(
        (await get('status=4xx')).items
          .map((i: { status: number }) => i.status)
          .sort(),
      ).toEqual([404, 429]);
      expect((await get('status=5xx')).items).toHaveLength(1);
      expect((await get('status=429')).items).toHaveLength(1);
      expect((await get('status=200')).items).toHaveLength(3);
      expect((await get('route=/v1/products/:id')).items).toHaveLength(1);
      expect((await get('keyId=key-2')).items).toHaveLength(1);
      expect((await get('livemode=false')).items).toHaveLength(1);
      expect(
        (await get(`from=${at(3).toISOString()}&to=${at(4).toISOString()}`))
          .items,
      ).toHaveLength(2);

      const p1 = await get('limit=2');
      const p2 = await get(`limit=2&cursor=${p1.nextCursor}`);
      const p3 = await get(`limit=2&cursor=${p2.nextCursor}`);
      const seen = [...p1.items, ...p2.items, ...p3.items].map(
        (i: { requestId: string }) => i.requestId,
      );
      expect(new Set(seen).size).toBe(6);
      expect(p3.nextCursor).toBeNull();
      const instants = [...p1.items, ...p2.items, ...p3.items].map(
        (i: { at: string }) => i.at,
      );
      expect(instants).toEqual([...instants].sort().reverse());
    });

    it('W04 B-4: GET logs answers {items, nextCursor} (requestLogPageSchema) with limit and cursor', async () => {
      const { w } = await world();
      const at = (s: number) =>
        new Date(Date.parse('2026-10-06T11:00:00.000Z') + s * 1_000);
      await project([
        record(w.shop.id, { status: 200, occurredAt: at(1) }),
        record(w.shop.id, { status: 200, occurredAt: at(2) }),
        record(w.shop.id, { status: 200, occurredAt: at(3) }),
      ]);
      const page = (q: string) =>
        t
          .as(w.owner)
          .get(`${LOGS(w.shop.id)}?${q}`)
          .expect(200)
          .then((r) => requestLogPageSchema.parse(r.body));
      const p1 = await page('limit=2');
      expect(p1.items).toHaveLength(2);
      expect(p1.nextCursor).toEqual(expect.any(String));
      const p2 = await page(
        `limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`,
      );
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
    });

    it.each([
      ['a from older than 30 days', 'from=2026-08-01T00:00:00.000Z'],
      [
        'a to before from',
        'from=2026-10-05T00:00:00.000Z&to=2026-10-04T00:00:00.000Z',
      ],
      ['an unknown status', 'status=teapot'],
      ['an unknown livemode', 'livemode=maybe'],
      ['limit 0', 'limit=0'],
      ['limit 101', 'limit=101'],
      ['an instant that is not ISO', 'from=yesterday'],
    ])('S42 AS-60: %s is 400', async (_n, q) => {
      const { w } = await world();
      const res = await t.as(w.owner).get(`${LOGS(w.shop.id)}?${q}`);
      expect(res.status).toBe(400);
    });

    it('S42 AS-60: a cursor that was not issued is 400 invalid_cursor', async () => {
      const { w } = await world();
      const res = await t
        .as(w.owner)
        .get(`${LOGS(w.shop.id)}?cursor=garbage`)
        .expect(400);
      expect(res.body.code).toBe('invalid_cursor');
    });

    it('S42 AS-60: a session is needed, a non-member gets 404, a viewer may read, and one shop never reads another’s log', async () => {
      const a = await world();
      const b = await world();
      const secret = record(b.w.shop.id);
      await project([secret]);
      await t.http().get(LOGS(a.w.shop.id)).expect(401);
      await t.as(b.w.owner).get(LOGS(a.w.shop.id)).expect(404);
      const viewer = await addShopMember(t, a.w.shop.id, 'VIEWER');
      await t.as(viewer).get(LOGS(a.w.shop.id)).expect(200);
      const attempt = await t
        .as(a.w.owner)
        .get(`${LOGS(a.w.shop.id)}?requestId=${secret.requestId}&keyId=key-1`)
        .expect(200);
      expect(attempt.body.items).toEqual([]);
    });
  });

  describe('AS-63, AS-35 usage report', () => {
    it('S42 AS-63: rows per day, version and route sorted by day then calls; errors are 5xx only; the sandbox and other shops are apart', async () => {
      const a = await world();
      const b = await world();
      const day = (d: number, s = 0) =>
        new Date(Date.UTC(2026, 9, d, 12, 0, s));
      await project([
        record(a.w.shop.id, { occurredAt: day(6, 1) }),
        record(a.w.shop.id, { occurredAt: day(6, 2) }),
        record(a.w.shop.id, { occurredAt: day(6, 3), status: 500 }),
        record(a.w.shop.id, {
          occurredAt: day(6, 4),
          route: '/v1/orders',
          version: '2026-01-15',
        }),
        record(a.w.shop.id, { occurredAt: day(5, 1), route: '/v1/orders' }),
        record(a.w.shop.id, { occurredAt: day(4, 1), livemode: false }),
        record(b.w.shop.id, { occurredAt: day(6, 5) }),
      ]);
      const res = await t
        .as(a.w.owner)
        .get(`${USAGE(a.w.shop.id)}?days=30`)
        .expect(200);
      expect(res.body.days).toEqual([
        {
          day: '2026-10-06',
          version: '2026-10-01',
          route: '/v1/products',
          calls: 3,
          errors: 1,
          deprecatedCalls: 0,
        },
        {
          day: '2026-10-06',
          version: '2026-01-15',
          route: '/v1/orders',
          calls: 1,
          errors: 0,
          deprecatedCalls: 0,
        },
        {
          day: '2026-10-05',
          version: '2026-10-01',
          route: '/v1/orders',
          calls: 1,
          errors: 0,
          deprecatedCalls: 0,
        },
      ]);
      const sandbox = await t
        .as(a.w.owner)
        .get(`${USAGE(a.w.shop.id)}?days=30&livemode=false`)
        .expect(200);
      expect(sandbox.body.days).toHaveLength(1);
      const oneDay = await t
        .as(a.w.owner)
        .get(`${USAGE(a.w.shop.id)}?days=1`)
        .expect(200);
      expect(
        oneDay.body.days.every((r: { day: string }) => r.day === '2026-10-06'),
      ).toBe(true);
    });

    it.each(['0', '31', 'x'])(
      'S42 AS-63: days=%s is 400, and shop.read is required',
      async (days) => {
        const { w } = await world();
        await t
          .as(w.owner)
          .get(`${USAGE(w.shop.id)}?days=${days}`)
          .expect(400);
        await t.http().get(USAGE(w.shop.id)).expect(401);
      },
    );

    it('S42 AS-35: the deprecated report lists per version, route and key the calls and the last call; the counter rose by the calls', async () => {
      const { w, key } = await world();
      const a2 = await createKey(t, w, { name: 'second' });
      const other = await world();
      const stockPath = `/v1/products/${newId()}/stock`;
      const counter = () =>
        MetricsRegistry.value('public_api_deprecated_calls_total', {
          route: '/v1/products/:id/stock',
          version: '2026-10-01',
        }) ?? 0;
      const before = counter();
      for (let i = 0; i < 3; i += 1) await pub.withKey(key.key).get(stockPath);
      t.clock.advance(60_000);
      await pub.withKey(a2.key).get(stockPath);
      await pub.withKey(other.key.key).get(stockPath);
      await pub.withKey(key.key).get('/v1/products');
      expect(counter() - before).toBe(5);

      await t.flushRecords();
      await project(t.records.records.filter((r) => r.shopId === w.shop.id));
      const res = await t
        .as(w.owner)
        .get(`${USAGE(w.shop.id)}?days=1&deprecated=true`)
        .expect(200);
      expect(res.body.keys).toEqual([
        {
          keyId: key.id,
          version: '2026-10-01',
          route: '/v1/products/:id/stock',
          calls: 3,
          errors: 0,
          lastCallAt: expect.any(String),
        },
        {
          keyId: a2.id,
          version: '2026-10-01',
          route: '/v1/products/:id/stock',
          calls: 1,
          errors: 0,
          lastCallAt: expect.any(String),
        },
      ]);
      const [first, second] = res.body.keys as { lastCallAt: string }[];
      expect(Date.parse(second.lastCallAt)).toBeGreaterThan(
        Date.parse(first.lastCallAt),
      );
      expect(
        res.body.keys.map((k: { keyId: string }) => k.keyId),
      ).not.toContain(other.key.id);
      expect(
        res.body.days.every(
          (r: { deprecatedCalls: number }) => r.deprecatedCalls > 0,
        ),
      ).toBe(true);
    });
  });

  describe('AS-64 exact usage events', () => {
    const metering = () => t.app.get(PublicApiUsageMeteringConsumer);
    const closer = () => t.app.get(UsageCloser);
    const feed = (records: RequestRecord[]) =>
      metering().project(records.map(requestLoggedEnvelope));
    const usage = (shopId: string) =>
      outboxEvents(t.app, 'usage.recorded', { aggregateId: shopId });

    it('S42 AS-64: the billable calls of a closed minute become one usage.recorded with the exact quantity and a derived event id', async () => {
      const { w } = await world();
      const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, s));
      await feed([
        ...Array.from({ length: 6 }, (_, i) =>
          record(w.shop.id, { occurredAt: at(i) }),
        ),
        record(w.shop.id, { occurredAt: at(10), status: 404 }),
        record(w.shop.id, { occurredAt: at(11), status: 500 }),
        record(w.shop.id, { occurredAt: at(12), status: 429 }),
        record(w.shop.id, {
          occurredAt: at(13),
          method: 'POST',
          route: '/v1/batch',
          cost: 5,
        }),
        record(w.shop.id, { occurredAt: at(14), livemode: false }),
      ]);
      t.clock.set(new Date('2026-10-06T12:01:04.000Z'));
      expect(await closer().close()).toBe(0); // the minute closed less than 5 s ago
      t.clock.set(new Date('2026-10-06T12:01:05.000Z'));
      expect(await closer().close()).toBe(1);
      const events = await usage(w.shop.id);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        metric: 'api.calls',
        quantity: 12,
        ts: '2026-10-06T12:00:00.000Z',
      });
      expect(events[0].aggregateId).toBe(w.shop.id);
      const [{ eventId }] = await rows<{ eventId: string }>(
        t.app,
        `SELECT payload->>'eventId' AS "eventId" FROM "Outbox" WHERE "eventName" = 'usage.recorded' AND "aggregateId" = :id`,
        { id: w.shop.id },
      );
      expect(eventId).toBe(
        usageEventId(
          w.shop.id,
          'api.calls',
          new Date('2026-10-06T12:00:00.000Z'),
          1,
        ),
      );
      expect(await closer().close()).toBe(0);
    });

    it('S42 AS-64: a record delivered twice counts once; a late record opens sequence 2 with quantity 1; an invalid record changes nothing', async () => {
      const { w } = await world();
      const one = record(w.shop.id, {
        occurredAt: new Date('2026-10-06T12:00:01.000Z'),
      });
      await feed([one]);
      await feed([one]);
      t.clock.set(new Date('2026-10-06T12:02:00.000Z'));
      await closer().close();
      expect((await usage(w.shop.id)).map((e) => e.payload.quantity)).toEqual([
        1,
      ]);

      await feed([
        record(w.shop.id, { occurredAt: new Date('2026-10-06T12:00:40.000Z') }),
      ]);
      await closer().close();
      const events = await usage(w.shop.id);
      expect(
        events.map((e) => [e.aggregateVersion, e.payload.quantity]),
      ).toEqual([
        [1, 1],
        [2, 1],
      ]);

      const bad = {
        ...requestLoggedEnvelope(record(w.shop.id)),
        payload: { requestId: 7 },
      };
      await expect(metering().project([bad as never])).rejects.toBeInstanceOf(
        PermanentError,
      );
      await closer().close();
      expect(await usage(w.shop.id)).toHaveLength(2);
    });

    it('S42 AS-64: the same request under the same event id from two consumers at once is counted once (20 repeats)', async () => {
      const { w } = await world();
      for (let i = 0; i < 20; i += 1) {
        const minute = Date.UTC(2026, 9, 7, 8, i, 0);
        const r = record(w.shop.id, {
          occurredAt: new Date(minute + 5_000),
          requestId: `req_${newId().replace(/-/g, '')}`,
        });
        await Promise.all([feed([r]), feed([r])]);
      }
      t.clock.set(new Date('2026-10-07T09:00:00.000Z'));
      await closer().close();
      const events = await usage(w.shop.id);
      expect(events).toHaveLength(20);
      expect(events.every((e) => e.payload.quantity === 1)).toBe(true);
    });

    it('S42 AS-24: a test key’s calls produce no usage event', async () => {
      const { w, test } = await world();
      const res = await pub.withKey(test.key).get('/v1/products').expect(200);
      const rec = await only(res.headers['request-id']);
      expect(rec.livemode).toBe(false);
      await feed([rec]);
      t.clock.advance(5 * 60_000);
      await closer().close();
      expect(await usage(w.shop.id)).toHaveLength(0);
    });
  });

  it('S42 AS-62: the event id of a record is derived from its request id', () => {
    expect(
      requestLoggedEnvelope(record('s', { requestId: 'req_x' })).eventId,
    ).toBe(recordEventId('req_x'));
  });
});
