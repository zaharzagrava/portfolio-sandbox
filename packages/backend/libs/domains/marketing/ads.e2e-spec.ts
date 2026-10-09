import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { LedgerService, shopAccount } from '@app/domains/payments';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { AdsModule, AdsWorkerModule } from './ads.module';
import { AdsService } from './application/ads.service';
import { AdBillingJobs } from './infra/ad-billing.jobs';
import { aggregateBatch } from './infra/click-aggregator.service';
import { TrendingConsumer, TrendingService } from '@app/domains/discovery';

@Module({
  imports: [
    AdsModule,
    AdsWorkerModule,
    CacheModule,
    SequelizeModule.forFeature([Shop]),
  ],
  providers: [TrendingConsumer, TrendingService],
})
class SpecModule {}

const chTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

/** SD-32 against real Postgres (ledger) + Redis + ClickHouse; Kafka hops replaced by direct inserts / spies. */
describe('Trending & sponsored clicks (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let ads: AdsService;
  let clickhouse: ClickHouseService;
  let produced: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    ads = app.get(AdsService);
    clickhouse = app.get(ClickHouseService);
    produced = jest
      .spyOn(app.get(KafkaProducerService), 'send')
      .mockResolvedValue(undefined as never);
    const ddl = readFileSync(
      join(process.cwd(), 'clickhouse/080_ads.sql'),
      'utf8',
    );
    for (const table of ['ad_clicks_raw', 'ad_click_minute']) {
      const start = ddl.indexOf(`CREATE TABLE IF NOT EXISTS ${table}\n`);
      await clickhouse
        .getClient()
        .command({ query: ddl.slice(start, ddl.indexOf(';', start)) });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    produced.mockClear();
    for (const t of ['ad_clicks_raw', 'ad_click_minute'])
      await clickhouse.getClient().command({ query: `TRUNCATE TABLE ${t}` });
  });

  const campaign = async (cpcCents = 25, dailyBudgetCents = 10_000) => {
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Ads', slug: `ads-${v4().slice(0, 8)}` });
    const [product] = await seeds.createTreelike([
      {
        __type__: TableName.Product,
        title: 'Promoted earbuds',
        shopId: shop.id,
        quantity: 10,
      },
    ]);
    const [c] = (await ads.createCampaign(shop.id, {
      productId: product.id,
      category: 'audio',
      cpcCents,
      dailyBudgetCents,
    })) as { id: string; shopId: string }[];
    return { campaignId: c.id, shopId: shop.id };
  };

  it('a served impression is billable once: repeat clicks and forged tokens are not counted; keys are salted', async () => {
    await campaign();
    const [slot] = await ads.sponsored('audio', 'viewer-1');
    const token = slot.clickUrl.split('/').pop()!;

    expect(await ads.click(token, '203.0.113.9')).toMatchObject({
      counted: true,
      valid: true,
    });
    expect(await ads.click(token, '203.0.113.9')).toMatchObject({
      counted: false,
    });
    expect(
      await ads.click(
        `${token.split('.')[0]}.forgedsignatureforgedsignature00`,
        '203.0.113.9',
      ),
    ).toMatchObject({ counted: false, redirectTo: '/' });
    expect(produced).toHaveBeenCalledTimes(1);
    expect(produced.mock.calls[0][0].key).toMatch(
      new RegExp(`^${slot.campaignId}#\\d$`),
    );
  });

  it('hourly billing charges clicks × CPC exactly once, capped by the daily budget; replayed aggregates replace, not add', async () => {
    const { campaignId, shopId } = await campaign(25, 1_000);
    const hour = new Date(
      Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000,
    );
    const minute = chTime(new Date(hour.getTime() + 5 * 60_000)).slice(0, 19);
    const batch = {
      campaign_id: campaignId,
      minute,
      source_partition: 3,
      first_offset: 100,
      clicks: 30,
      invalid: 2,
    };
    await clickhouse
      .getClient()
      .insert({
        table: 'ad_click_minute',
        format: 'JSONEachRow',
        values: [
          batch,
          batch,
          { ...batch, source_partition: 4, first_offset: 7, clicks: 10 },
        ],
      });

    expect(
      await app.get(AdBillingJobs).billHour({ hour: hour.toISOString() }),
    ).toEqual({ campaigns: 1, amountCents: 1_000 }); // 40 × 25 = 1000 = budget
    expect(
      await app.get(AdBillingJobs).billHour({ hour: hour.toISOString() }),
    ).toEqual({ campaigns: 1, amountCents: 0 });
    expect(await app.get(LedgerService).balance(shopAccount(shopId))).toBe(
      -1_000,
    );
  });

  it('daily reconciliation recomputes from deduplicated raw clicks and posts the difference', async () => {
    const { campaignId, shopId } = await campaign(25, 100_000);
    const hour = new Date(
      Math.floor(Date.now() / 86_400_000) * 86_400_000 -
        86_400_000 +
        10 * 3_600_000,
    ); // yesterday 10:00
    await clickhouse
      .getClient()
      .insert({
        table: 'ad_click_minute',
        format: 'JSONEachRow',
        values: [
          {
            campaign_id: campaignId,
            minute: chTime(hour).slice(0, 19),
            source_partition: 0,
            first_offset: 0,
            clicks: 12,
            invalid: 0,
          },
        ],
      });
    await app.get(AdBillingJobs).billHour({ hour: hour.toISOString() });

    const raw = (id: string, valid = 1) => ({
      click_id: id,
      campaign_id: campaignId,
      shop_id: shopId,
      ts: chTime(new Date(hour.getTime() + 60_000)),
      ip_hash: 'x',
      valid,
    });
    const ids = Array.from({ length: 10 }, () => v4());
    await clickhouse
      .getClient()
      .insert({
        table: 'ad_clicks_raw',
        format: 'JSONEachRow',
        values: [...ids.map((id) => raw(id)), raw(ids[0]), raw(v4(), 0)],
      }); // 10 valid unique, 1 dup, 1 invalid

    expect(
      await app
        .get(AdBillingJobs)
        .reconcileDay({ day: hour.toISOString().slice(0, 10) }),
    ).toBe(1);
    expect(await app.get(LedgerService).balance(shopAccount(shopId))).toBe(
      -10 * 25,
    ); // 12 billed → corrected to 10
    expect(
      await app
        .get(AdBillingJobs)
        .reconcileDay({ day: hour.toISOString().slice(0, 10) }),
    ).toBe(0); // idempotent
  });

  it('aggregateBatch tags each (campaign, minute) with the batch identity', () => {
    const r = (campaign: string, ts: string, valid = 1) => ({
      click_id: v4(),
      campaign_id: campaign,
      shop_id: 's',
      ts,
      ip_hash: 'h',
      valid,
    });
    expect(
      aggregateBatch(2, 500, [
        r('a', '2026-10-01 10:00:05.000'),
        r('a', '2026-10-01 10:00:59.000', 0),
        r('a', '2026-10-01 10:01:00.000'),
        r('b', '2026-10-01 10:00:01.000'),
      ]),
    ).toEqual([
      {
        campaign_id: 'a',
        minute: '2026-10-01 10:00:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 1,
      },
      {
        campaign_id: 'a',
        minute: '2026-10-01 10:01:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 0,
      },
      {
        campaign_id: 'b',
        minute: '2026-10-01 10:00:00',
        source_partition: 2,
        first_offset: 500,
        clicks: 1,
        invalid: 0,
      },
    ]);
  });

  it('trending: weighted views/add-to-carts per closed window → hourly ranking (add-to-cart counts 5×)', async () => {
    const [a, b, c] = await seeds.createTreelike(
      ['A', 'B', 'C'].map((title) => ({
        __type__: TableName.Product,
        title,
        quantity: 5,
        category: 'audio',
      })),
    );
    const consumer = app.get(TrendingConsumer);
    const ts = chTime(new Date(Date.now() - 5 * 60_000));
    const emit = (name: string, productId: string, n: number) => {
      for (let i = 0; i < n; i++)
        consumer.ingest({
          name,
          ts,
          props: { product_id: productId, category: 'audio' },
        });
    };
    emit('product_view', a.id, 30);
    emit('product_view', b.id, 10);
    emit('add_to_cart', b.id, 5); // 10 + 25 = 35 > 30
    emit('product_view', c.id, 3);
    await consumer.flush(true);

    const list = await app.get(TrendingService).trending('audio');
    expect(list.map((p) => p.title)).toEqual(['B', 'A', 'C']);
  });
});
