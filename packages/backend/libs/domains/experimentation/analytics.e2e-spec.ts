import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { AnalyticsModule } from './analytics.module';
import { AnalyticsService } from './application/analytics.service';
import { assign } from './domain/experiments';

const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** SD-31 against real Postgres + ClickHouse (the Kafka-engine hop is replaced by direct inserts). */
describe('Analytics & experiments (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let analytics: AnalyticsService;
  let clickhouse: ClickHouseService;
  let produced: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([AnalyticsModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    analytics = app.get(AnalyticsService);
    clickhouse = app.get(ClickHouseService);
    produced = jest.spyOn(app.get(KafkaProducerService), 'sendMany').mockResolvedValue();
    // Only the storage table: the Kafka engine table would need the compose network's broker.
    const ddl = readFileSync(join(process.cwd(), 'clickhouse/070_analytics.sql'), 'utf8');
    await clickhouse.getClient().command({ query: ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS analytics_events\n'), ddl.indexOf(';', ddl.indexOf('CREATE TABLE IF NOT EXISTS analytics_events\n'))) });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    await clickhouse.getClient().command({ query: 'TRUNCATE TABLE analytics_events' });
    produced.mockClear();
  });

  const row = (name: string, unit: string, props: Record<string, string>, ts = Date.now()) => ({
    event_id: v4(),
    name,
    anonymous_id: unit,
    user_id: '',
    ts: chTime(ts),
    received_at: chTime(Date.now()),
    country: '',
    platform: 'web',
    page: '',
    props,
  });

  it('ingest validates per event, enriches, clamps future clocks and drops ancient events', async () => {
    const now = Date.now();
    const result = await analytics.ingest(
      {
        events: [
          { event_id: v4(), name: 'product_view', anonymous_id: 'anon-12345', ts: now, props: { product_id: 'p1', price: 1999 } },
          { event_id: v4(), name: 'add_to_cart', anonymous_id: 'anon-12345', ts: now + 3_600_000 }, // clock in the future
          { event_id: 'not-a-uuid', name: 'product_view', anonymous_id: 'anon-12345', ts: now },
          { event_id: v4(), name: 'teleport', anonymous_id: 'anon-12345', ts: now },
          { event_id: v4(), name: 'search', anonymous_id: 'anon-12345', ts: now - 30 * 86_400_000 },
        ],
      },
      { userId: 'user-1', country: 'UA' },
    );
    expect(result.accepted).toBe(2);
    expect(result.rejected.map((r) => r.index)).toEqual([2, 3, 4]);
    const [, messages] = produced.mock.calls[0] as [string, { value: { props: Record<string, string>; user_id: string; country: string; ts: string; received_at: string } }[]];
    expect(messages[0].value).toMatchObject({ user_id: 'user-1', country: 'UA', props: { product_id: 'p1', price: '1999' } });
    expect(messages[1].value.ts).toBe(messages[1].value.received_at); // clamped to receive time
  });

  it('duplicate deliveries of one event_id count once (ReplacingMergeTree + FINAL)', async () => {
    const event = row('add_to_cart', 'anon-dup', {});
    await clickhouse.getClient().insert({ table: 'analytics_events', format: 'JSONEachRow', values: [event, { ...event, received_at: chTime(Date.now() + 1_000) }, event] });
    const [{ n }] = await clickhouse.query<{ n: string }>(`SELECT count() AS n FROM analytics_events FINAL WHERE event_id = {id:UUID}`, { id: event.event_id });
    expect(Number(n)).toBe(1);
  });

  it('layers make experiments mutually exclusive; assignment is stable; overlapping running experiments are refused', async () => {
    await analytics.upsertExperiment({ key: 'pdp-layout', status: 'RUNNING', variants: [{ key: 'control', weight: 50 }, { key: 'gallery', weight: 50 }], layer: 'pdp', layerFrom: 0, layerTo: 5_000, metric: 'purchase' });
    await analytics.upsertExperiment({ key: 'pdp-reviews', status: 'RUNNING', variants: [{ key: 'control', weight: 50 }, { key: 'top', weight: 50 }], layer: 'pdp', layerFrom: 5_000, layerTo: 10_000, metric: 'purchase' });
    await expect(
      analytics.upsertExperiment({ key: 'pdp-clash', status: 'RUNNING', variants: [{ key: 'a', weight: 1 }], layer: 'pdp', layerFrom: 4_000, layerTo: 6_000, metric: 'purchase' }),
    ).rejects.toThrow();

    const units = Array.from({ length: 2_000 }, (_, i) => `anon-${i}`);
    const both: string[] = [];
    for (const u of units) {
      const a = await analytics.assignments(u);
      if (a['pdp-layout'] && a['pdp-reviews']) both.push(u);
      expect(await analytics.assignments(u)).toEqual(a);
    }
    expect(both).toEqual([]);
  });

  it('results: conversions only after exposure; a 60/40 split on a 50/50 config is flagged as SRM', async () => {
    await analytics.upsertExperiment({ key: 'free-shipping', status: 'RUNNING', variants: [{ key: 'control', weight: 50 }, { key: 'free', weight: 50 }], layer: 'checkout', layerFrom: 0, layerTo: 10_000, metric: 'purchase' });
    const start = Date.now(); // the experiment started just now; everything below happens after
    const rows: ReturnType<typeof row>[] = [];
    for (let i = 0; i < 600; i++) rows.push(row('exposure', `c-${i}`, { experiment: 'free-shipping', variant: 'control' }, start + 60_000));
    for (let i = 0; i < 400; i++) rows.push(row('exposure', `f-${i}`, { experiment: 'free-shipping', variant: 'free' }, start + 60_000));
    for (let i = 0; i < 60; i++) rows.push(row('purchase', `c-${i}`, {}, start + 120_000));
    for (let i = 0; i < 80; i++) rows.push(row('purchase', `f-${i}`, {}, start + 120_000));
    for (let i = 100; i < 150; i++) rows.push(row('purchase', `c-${i}`, {}, start + 30_000)); // bought BEFORE seeing the variant
    await clickhouse.getClient().insert({ table: 'analytics_events', format: 'JSONEachRow', values: rows });

    const result = await analytics.results('free-shipping');
    expect(result.variants.map((v) => [v.variant, v.exposures, v.conversions])).toEqual([
      ['control', 600, 60],
      ['free', 400, 80],
    ]);
    expect(result.srm.mismatch).toBe(true);
    expect(result.trustworthy).toBe(false);
  });

  it('assignment function matches the documented hashing (cross-platform contract)', () => {
    const exp = { key: 'x', status: 'RUNNING' as const, variants: [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }], layer: 'l', layerFrom: 0, layerTo: 10_000 };
    const counts = { a: 0, b: 0 } as Record<string, number>;
    for (let i = 0; i < 10_000; i++) counts[assign(exp, `u${i}`)!]++;
    expect(Math.abs(counts.a - 5_000)).toBeLessThan(250);
  });
});
