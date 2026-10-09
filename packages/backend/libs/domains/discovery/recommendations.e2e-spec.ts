import { INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { RecommendationsModule } from './recommendations.module';
import { RecommendationsWorkerModule } from './recommendations-worker.module';
import { CoOccurrenceJobs } from './infra/co-occurrence.jobs';
import { boughtTogetherKey } from './infra/recommendation-keys';

@Module({
  imports: [
    RecommendationsModule,
    RecommendationsWorkerModule,
    RateLimitModule,
  ],
})
class SpecModule {}

/** X-01 against real ClickHouse + Redis + Postgres: baskets → nightly build → ZSETs → endpoint. */
describe('Bought together (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis'],
    });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    clickhouse = app.get(ClickHouseService);
    await applyClickHouseDdl(clickhouse, '040_order_baskets.sql');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    await clickhouse
      .getClient()
      .command({ query: 'TRUNCATE TABLE order_baskets' });
  });

  const baskets = (products: string[], times: number) =>
    Array.from({ length: times }, () => ({
      order_id: v4(),
      products: [...products].sort(),
      ts: new Date().toISOString().replace('Z', ''),
    }));

  it('cosine beats raw popularity; noise pairs and duplicates do not count; 2-hop fills cold products', async () => {
    const [iphone, magsafe, case17, cable, stand] = await seeds.createTreelike(
      [
        'iPhone 17',
        'MagSafe Charger',
        'iPhone 17 Case',
        'USB-C Cable',
        'Charging Stand',
      ].map((title) => ({ __type__: TableName.Product, title, quantity: 10 })),
    );
    const duplicated = baskets([magsafe.id, case17.id], 1);
    await clickhouse.getClient().insert({
      table: 'order_baskets',
      format: 'JSONEachRow',
      values: [
        ...baskets([iphone.id, magsafe.id], 6), // iPhone is everywhere...
        ...baskets([iphone.id, cable.id], 40),
        ...baskets([iphone.id, case17.id], 40),
        ...baskets([magsafe.id, case17.id], 5), // ...but MagSafe ↔ case is the tighter bond
        ...duplicated,
        ...duplicated, // Kafka redelivery: same order_id, collapsed by FINAL
        ...baskets([magsafe.id, stand.id], 2), // below MIN_CO_ORDERS
        ...baskets([cable.id, stand.id], 3),
      ],
    });

    const { edges } = await app.get(CoOccurrenceJobs).build({ buckets: 4 });
    expect(edges).toBeGreaterThan(0);

    const magsafeList = await app
      .get(RedisService)
      .client.zrevrange(boughtTogetherKey(magsafe.id), 0, -1);
    expect(magsafeList).toEqual([case17.id, iphone.id]); // 6 co-orders with a hub < 6 with a niche item
    expect(magsafeList).not.toContain(stand.id);

    // Stand has one direct edge (cable) → expansion through the cable's neighbours.
    const res = await request(app.getHttpServer())
      .get(`/api/products/${stand.id}/recommendations`)
      .expect(200);
    expect(res.body[0]).toMatchObject({ productId: cable.id, hops: 1 });
    expect(
      res.body
        .slice(1)
        .map((r: { productId: string; hops: number }) => [r.productId, r.hops]),
    ).toContainEqual([iphone.id, 2]);
    expect(
      res.body.map((r: { productId: string }) => r.productId),
    ).not.toContain(stand.id);
    expect(res.headers['cache-control']).toContain('s-maxage=300');
  });

  it('out-of-stock neighbours are hidden at read time', async () => {
    const [a, b, c] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'A', quantity: 5 },
      { __type__: TableName.Product, title: 'B', quantity: 0 },
      { __type__: TableName.Product, title: 'C', quantity: 5 },
    ]);
    await clickhouse.getClient().insert({
      table: 'order_baskets',
      format: 'JSONEachRow',
      values: [...baskets([a.id, b.id], 5), ...baskets([a.id, c.id], 3)],
    });
    await app.get(CoOccurrenceJobs).build({ buckets: 1 });

    const res = await request(app.getHttpServer())
      .get(`/api/products/${a.id}/recommendations`)
      .expect(200);
    expect(res.body.map((r: { productId: string }) => r.productId)).toEqual([
      c.id,
    ]);
  });
});
