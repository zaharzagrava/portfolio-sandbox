import { randomUUID } from 'node:crypto';
import {
  productSearchResponseSchema,
  searchEventSchemas,
  searchQualityReportSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import {
  createTopics,
  deleteTopicsMatching,
  testKafka,
} from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import { SearchPerformed } from './application/events/search-query-events';
import { SearchResultClicked } from './application/events/search-click-events';
import { SEARCH_ID_TTL_MS } from './domain/search-id';
import { SEARCH_EVENT_PUBLISHER } from './domain/ports';
import { SearchClicksProjector } from './infra/search-clicks.projector';
import { SearchQueriesProjector } from './infra/search-queries.projector';
import { SearchProjectorModule } from './search-projector.module';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import { newId } from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

const counter = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const truncate = (clickhouse: ClickHouseService, table: string) =>
  clickhouse.getClient().command({ query: `TRUNCATE TABLE IF EXISTS ${table}` });

type Published = {
  type: string;
  eventId: string;
  occurredAt: string;
  aggregateId: string;
  version: number;
  payload: Record<string, unknown>;
};

describe('Search click-through measurement', () => {
  let t: SearchTestApp;
  let shopId: string;
  let published: jest.SpyInstance;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    t = await createSearchApp({ kafkaProxy: true, redisProxy: true });
    clickhouse = t.app.get(ClickHouseService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    await truncate(clickhouse, 'search_queries');
    await truncate(clickhouse, 'search_clicks');
    shopId = newId();
    const adapter = t.app.get(SEARCH_EVENT_PUBLISHER, {
      strict: false,
    }) as unknown as { publisher: EventPublisher };
    published = jest.spyOn(adapter.publisher, 'publish');
  });
  afterEach(() => jest.restoreAllMocks());

  const emitted = (type: string): Published[] =>
    published.mock.calls
      .map(([e]) => e as Published)
      .filter((e) => e.type === type);
  const wire = (e: Published) => ({
    eventId: e.eventId,
    type: e.type,
    version: e.version,
    occurredAt: e.occurredAt,
    aggregateId: e.aggregateId,
    payload: e.payload,
  });
  const search = (query: Record<string, string | number>) =>
    t.http().get('/api/products/search').query(query);
  const searched = async (query: Record<string, string | number>) =>
    productSearchResponseSchema.parse((await search(query).expect(200)).body);
  const click = (body: unknown) =>
    t.http().post('/api/search/clicks').send(body as object);
  const rowCount = async (table: string, where = '1') =>
    Number(
      (
        await clickhouse.query<{ n: string }>(
          `SELECT count() AS n FROM ${table} FINAL WHERE ${where}`,
        )
      )[0].n,
    );

  describe('the click endpoint (AS-70, AS-71)', () => {
    it('S32 AS-70: a valid click answers 202 with an empty body, emits search.result_clicked with the search\'s query, and projects to one row', async () => {
      const [p1] = await seedProducts(t, shopId, [{ title: 'iPhone 17 Case' }]);
      const { searchId } = await searched({ q: 'iphone' });

      const res = await click({ searchId, productId: p1, position: 0 }).expect(202);

      expect(res.text).toBe('');
      const [event] = emitted('search.result_clicked');
      expect(event.payload).toEqual({
        searchId,
        query: 'iphone',
        productId: p1,
        position: 0,
      });
      expect(searchEventSchemas['search.result_clicked'].safeParse(wire(event)).success).toBe(true);

      await t.app.get(SearchClicksProjector).project([event as never]);
      expect(await rowCount('search_clicks', `product_id = '${p1}'`)).toBe(1);
    });

    it('S32 AS-71: forged, altered, expired and missing search ids answer 422 invalid_search_id and emit nothing', async () => {
      const [p1] = await seedProducts(t, shopId, [{ title: 'iPhone 17 Case' }]);
      const { searchId } = await searched({ q: 'iphone' });
      const [head, body, mac] = searchId.split('.');
      const flipped = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
      const attempts: unknown[] = [
        { searchId: 'v1.forged.token', productId: p1, position: 0 },
        { searchId: `${head}.${flipped}.${mac}`, productId: p1, position: 0 },
        { searchId: 'garbage', productId: p1, position: 0 },
        { productId: p1, position: 0 },
      ];
      for (const attempt of attempts) {
        const res = await click(attempt).expect(422);
        expect(res.body.code).toBe('invalid_search_id');
      }

      t.clock.advance(SEARCH_ID_TTL_MS + 1_000);
      const expired = await click({ searchId, productId: p1, position: 0 }).expect(422);
      expect(expired.body.code).toBe('invalid_search_id');
      expect(emitted('search.result_clicked')).toEqual([]);
    });

    it.each([
      ['negative position', { position: -1 }],
      ['position 100', { position: 100 }],
      ['fractional position', { position: 1.5 }],
      ['non-uuid product', { productId: 'nope' }],
      ['unknown field', { extra: true }],
    ] as [string, Record<string, unknown>][])(
      'S32 AS-71: %s answers 400 validation_failed',
      async (_name, patch) => {
        const [p1] = await seedProducts(t, shopId, [{ title: 'iPhone 17 Case' }]);
        const { searchId } = await searched({ q: 'iphone' });
        const res = await click({
          searchId,
          productId: p1,
          position: 0,
          ...patch,
        }).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(emitted('search.result_clicked')).toEqual([]);
      },
    );

    it('S32 AS-71: past 300 clicks a minute from one address the answer is 429 with Retry-After', async () => {
      const [p1] = await seedProducts(t, shopId, [{ title: 'iPhone 17 Case' }]);
      const { searchId } = await searched({ q: 'iphone' });
      let limited: { status: number; headers: Record<string, string> } | undefined;
      for (let i = 0; i < 305 && !limited; i++) {
        const res = await click({ searchId, productId: p1, position: i % 50 });
        if (res.status === 429) limited = res;
      }
      expect(limited?.status).toBe(429);
      expect(limited?.headers['retry-after']).toBeDefined();
    });
  });

  describe('the quality report (AS-73)', () => {
    const at = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000 - 60_000);
    const performedAt = (query: string, results: number, when: Date) =>
      SearchPerformed.create(randomUUID(), 0, {
        searchId: randomUUID(),
        query,
        results,
        mode: 'lexical',
        userHash: 'h',
        filters: [],
        degraded: [],
        surface: 'http',
      } as never, when);
    const clickedAt = (query: string, position: number, when: Date) =>
      SearchResultClicked.create(randomUUID(), 0, {
        searchId: randomUUID(),
        query,
        productId: randomUUID(),
        position,
      }, when);
    const report = (query: Record<string, string | number>, admin = true) =>
      (admin ? t.as(adminUser) : t.http())
        .get('/api/admin/search/quality')
        .query(query);
    let adminUser: Awaited<ReturnType<SearchTestApp['admin']>>;

    beforeEach(async () => {
      adminUser = await t.admin();
    });

    it('S32 AS-73: CTR, MRR and zero-result rate per query over the window, most-searched first, with exact numbers', async () => {
      const queries = t.app.get(SearchQueriesProjector);
      const clicks = t.app.get(SearchClicksProjector);
      await queries.project([
        ...Array.from({ length: 10 }, (_, i) =>
          performedAt('iphone', i < 2 ? 0 : 5, at(1)),
        ),
        ...Array.from({ length: 3 }, () => performedAt('cable', 1, at(1))),
        ...Array.from({ length: 50 }, () => performedAt('old news', 1, at(10))),
      ] as never);
      await clicks.project(
        [0, 0, 1, 4].map((p) => clickedAt('iphone', p, at(1))) as never,
      );

      const res = await report({ days: 7, limit: 50 }).expect(200);
      const { rows } = searchQualityReportSchema.parse(res.body);

      expect(rows.map((r) => r.query)).toEqual(['iphone', 'cable']);
      expect(rows[0]).toEqual({
        query: 'iphone',
        searches: 10,
        ctr: 0.4,
        mrr: 0.27,
        zeroResultRate: 0.2,
      });
      expect(rows[1]).toMatchObject({ searches: 3, ctr: 0, zeroResultRate: 0 });
      const limited = await report({ days: 7, limit: 1 }).expect(200);
      expect(limited.body.rows).toHaveLength(1);
      const wide = await report({ days: 30 }).expect(200);
      expect(wide.body.rows.map((r: { query: string }) => r.query)).toContain(
        'old news',
      );
    });

    it.each([
      ['days 0', { days: 0 }],
      ['days 91', { days: 91 }],
      ['days not a number', { days: 'abc' }],
      ['limit 0', { limit: 0 }],
      ['limit 101', { limit: 101 }],
      ['unknown parameter', { window: 7 }],
    ] as [string, Record<string, string | number>][])(
      'S32 AS-73: %s answers 400 validation_failed (no silent clamping)',
      async (_name, query) => {
        const res = await report(query).expect(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );

    it('S32 AS-73: the report needs an administrator', async () => {
      await report({}, false).expect(401);
      const user = await t.newUser();
      await t.as(user).get('/api/admin/search/quality').expect(403);
    });
  });

  describe('privacy and events (AS-74, AS-76)', () => {
    it('S32 AS-74: a query with an email is stored as [redacted] with its result count; the log tables expire rows after 90 days', async () => {
      await seedProducts(t, shopId, [{ title: 'Mail Stand' }]);
      await searched({ q: 'mail stand' });
      await searched({ q: 'me@example.com' });

      const events = emitted('search.performed');
      expect(events.map((e) => e.payload.query)).toEqual([
        'mail stand',
        '[redacted]',
      ]);
      await t.app.get(SearchQueriesProjector).project(events as never);
      const rows = await clickhouse.query<{ query: string; results: number }>(
        `SELECT query, results FROM search_queries FINAL ORDER BY query`,
      );
      expect(rows.map((r) => r.query)).toEqual(['[redacted]', 'mail stand']);
      expect(Number(rows[0].results)).toBe(0);

      for (const table of ['search_queries', 'search_clicks']) {
        const [{ statement }] = await clickhouse.query<{ statement: string }>(
          `SELECT create_table_query AS statement FROM system.tables WHERE name = '${table}' AND database = currentDatabase()`,
        );
        expect(statement).toMatch(/TTL[^]*toIntervalDay\(90\)/);
      }
    });

    it('S32 AS-76: every mode and filter set emits a search.performed that parses with the contract', async () => {
      t.embeddings.concept('winter coat', 'parka');
      await seedProducts(t, shopId, [
        { title: 'Alpine Parka', category: 'coats', brand: 'Acme' },
      ]);
      await searched({ q: 'parka' });
      await searched({ q: 'parka', category: 'coats', brand: 'Acme', inStock: 'true', minRating: 0, minPriceMinor: 1, maxPriceMinor: 99_999 });
      await searched({ q: 'winter coat', semantic: 'true' });
      t.embeddings.failing = true;
      await searched({ q: 'winter coat', semantic: 'true' });

      const events = emitted('search.performed');
      expect(events).toHaveLength(4);
      for (const event of events)
        expect(searchEventSchemas['search.performed'].safeParse(wire(event)).success).toBe(true);
      expect(events.map((e) => e.payload.mode)).toEqual([
        'lexical',
        'lexical',
        'semantic',
        'lexical',
      ]);
      expect(events[1].payload.filters).toEqual(
        expect.arrayContaining(['category', 'brand', 'inStock', 'minRating', 'minPriceMinor', 'maxPriceMinor']),
      );
      expect(JSON.stringify(events[1].payload)).not.toContain('Acme');
      expect(events[3].payload.degraded).toEqual(['semantic_unavailable']);
      expect(events.every((e) => e.aggregateId === e.payload.searchId)).toBe(true);
    });
  });

  describe('logging never hurts search (AS-75)', () => {
    it('S32 AS-75: with the event stream down a search answers 200, a click 202, and the drop counter rises', async () => {
      const [p1] = await seedProducts(t, shopId, [{ title: 'iPhone 17 Case' }]);
      const { searchId } = await searched({ q: 'iphone' });
      const before = (type: string) =>
        counter('search_events_dropped_total', { type });
      const dropsBefore = {
        performed: before('search.performed'),
        clicked: before('search.result_clicked'),
      };
      t.kafkaProxy!.mode = 'refuse';
      t.kafkaProxy!.sever();

      const started = Date.now();
      const found = await search({ q: 'iphone' });
      const clicked = await click({ searchId, productId: p1, position: 0 });

      expect(found.status).toBe(200);
      expect(clicked.status).toBe(202);
      expect(Date.now() - started).toBeLessThan(3_000);
      await waitFor(
        async () =>
          before('search.performed') > dropsBefore.performed &&
          before('search.result_clicked') > dropsBefore.clicked,
        { description: 'drops counted', timeoutMs: 60_000 },
      );
    }, 90_000);
  });
});

describe('Search click and query consumers through the consumer framework', () => {
  let t: SearchTestApp;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    await deleteTopicsMatching(
      /^(search\.events|search-clicks\.dlq|search-queries\.dlq)$/,
    );
    await createTopics([
      { topic: 'search.events' },
      { topic: 'search-clicks.dlq' },
      { topic: 'search-queries.dlq' },
    ]);
    t = await createSearchApp({
      extraImports: [
        ProjectionsModule.forProjectors(SearchProjectorModule.projectors, [
          SearchProjectorModule,
        ]),
      ],
    });
    clickhouse = t.app.get(ClickHouseService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    await truncate(clickhouse, 'search_clicks');
  });

  const send = async (messages: { key: string; value: unknown }[]) => {
    const producer = testKafka().producer();
    await producer.connect();
    await producer.send({
      topic: 'search.events',
      messages: messages.map((m) => ({
        key: m.key,
        value: JSON.stringify(m.value),
      })),
    });
    await producer.disconnect();
  };
  const clicksFor = async (eventId: string) =>
    Number(
      (
        await clickhouse.query<{ n: string }>(
          `SELECT count() AS n FROM search_clicks FINAL WHERE event_id = '${eventId}'`,
        )
      )[0].n,
    );

  it('S32 AS-72: the same click delivered twice is one row; an invalid payload is dead-lettered and leaves no row', async () => {
    const valid = SearchResultClicked.create('s1', 0, {
      searchId: 's1',
      query: 'iphone',
      productId: randomUUID(),
      position: 2,
    });
    const poison = {
      ...SearchResultClicked.create('s2', 0, {
        searchId: 's2',
        query: 'iphone',
        productId: randomUUID(),
        position: 2,
      }),
    };
    (poison.payload as Record<string, unknown>).position = -3;
    delete (poison.payload as Record<string, unknown>).searchId;
    const last = SearchResultClicked.create('s3', 0, {
      searchId: 's3',
      query: 'iphone',
      productId: randomUUID(),
      position: 0,
    });

    await send([
      { key: 's1', value: valid },
      { key: 's1', value: valid },
      { key: 's2', value: poison },
      { key: 's3', value: last },
    ]);

    await waitFor(async () => (await clicksFor(last.eventId)) === 1, {
      description: 'later message processed',
      timeoutMs: 30_000,
    });
    expect(await clicksFor(valid.eventId)).toBe(1);
    expect(await clicksFor(poison.eventId)).toBe(0);
    const reader = testKafka().consumer({ groupId: `raw-${randomUUID()}` });
    await reader.connect();
    await reader.subscribe({ topic: 'search-clicks.dlq', fromBeginning: true });
    const seen: string[] = [];
    await reader.run({
      eachMessage: async ({ message }) =>
        void seen.push(message.key?.toString() ?? ''),
    });
    await waitFor(async () => seen.includes('s2'), {
      description: 'dead letter written',
      timeoutMs: 30_000,
    });
    await reader.disconnect();
  });
});
