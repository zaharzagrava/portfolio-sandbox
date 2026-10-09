import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ApiConfigService } from '@app/common/config';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { NotificationRouter } from '@app/domains/notifications';
import {
  ShopModel as Shop,
  ShopMembershipModel as ShopMembership,
} from '@app/domains/tenancy';
import { CrawlerModule } from './crawler.module';
import { CrawlerService } from './application/crawler.service';

@Module({
  imports: [CrawlerModule, SequelizeModule.forFeature([Shop, ShopMembership])],
})
class SpecModule {}

/** SD-35 against real Postgres + Redis + MinIO + ClickHouse, crawling a local fixture site. */
describe('Competitor price crawler (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let crawler: CrawlerService;
  let db: Sequelize;
  let site: http.Server;
  let base: string;
  let competitorPrice = 899.0;
  const hits: string[] = [];
  let dispatch: jest.SpyInstance;

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/robots.txt')
        return res.end('User-agent: *\nDisallow: /private\nCrawl-delay: 2\n');
      if (req.url!.startsWith('/p/')) {
        return res.end(
          `<html><head><script type="application/ld+json">{"@type":"Product","name":"iPhone 17","offers":{"@type":"Offer","price":"${competitorPrice.toFixed(2)}","priceCurrency":"USD"}}</script></head>
           <body><h1>iPhone 17 Pro</h1><p>${'Great phone with titanium design and a fast chip. '.repeat(40)}</p><p>Price: $${competitorPrice}</p></body></html>`,
        );
      }
      res.end('<html><body>secret</body></html>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
      stores: ['redis', 'storage'],
    });
    app = moduleRef.createNestApplication();
    const config = app.get(ApiConfigService);
    const get = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key === 'webhooks_allow_private_hosts'
          ? '127.0.0.1'
          : get(key as never)) as typeof config.get);
    await app.init();
    seeds = app.get(SeedsService);
    crawler = app.get(CrawlerService);
    db = app.get(getConnectionToken());
    dispatch = jest
      .spyOn(app.get(NotificationRouter), 'dispatch')
      .mockResolvedValue();
    await applyClickHouseDdl(
      app.get(ClickHouseService),
      '090_competitor_prices.sql',
    );
  });

  afterAll(async () => {
    await app.close();
    site.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    hits.length = 0;
    dispatch.mockClear();
    competitorPrice = 899;
    const redis = app.get(RedisService).client;
    const keys = await redis.keys('crawl:*');
    if (keys.length) await redis.del(...keys);
  });

  const shopWithProduct = async (priceMinor: number) => {
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Mine', slug: `m-${v4().slice(0, 8)}` });
    const [owner, product] = await seeds.createTreelike([
      { __type__: TableName.User },
      {
        __type__: TableName.Product,
        title: 'iPhone 17',
        shopId: shop.id,
        price: priceMinor,
      },
    ]);
    await app
      .get<typeof ShopMembership>(getModelToken(ShopMembership))
      .create({ shopId: shop.id, userId: owner.id, role: 'OWNER' });
    return {
      shopId: shop.id,
      productId: product.id as string,
      ownerId: owner.id as string,
    };
  };
  const target = async (id: string) =>
    (
      await db.query<{
        lastStatus: string;
        lastPriceMinor: string;
        unchangedStreak: number;
        nextCheckAt: Date;
      }>(`SELECT * FROM "CrawlTarget" WHERE id = :id`, {
        type: QueryTypes.SELECT,
        replacements: { id },
      })
    )[0];

  it('JSON-LD price is recorded; the owner is alerted only when undercut', async () => {
    const mine = await shopWithProduct(99_900);
    const { targetId } = await crawler.watch(
      mine.shopId,
      mine.productId,
      `${base}/p/iphone?utm_source=ads`,
    );
    await crawler.crawl(targetId);
    expect(await target(targetId)).toMatchObject({
      lastStatus: 'ok',
      lastPriceMinor: '89900',
    });
    expect(dispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'competitor.price_drop',
        userId: mine.ownerId,
        data: expect.objectContaining({ competitorPrice: '$899.00' }),
      }),
    ]);
    const [{ n }] = await app
      .get(ClickHouseService)
      .query<{ n: string }>(
        `SELECT count() AS n FROM competitor_prices WHERE target_id = {id:String}`,
        { id: targetId },
      );
    expect(Number(n)).toBe(1);

    dispatch.mockClear();
    competitorPrice = 1_099; // a one-token change: SimHash alone would call this page "unchanged"
    await crawler.crawl(targetId);
    expect(await target(targetId)).toMatchObject({
      lastStatus: 'ok',
      lastPriceMinor: '109900',
    }); // the price change is NOT missed
    expect(dispatch).not.toHaveBeenCalled(); // raised, not undercutting
  });

  it('robots.txt: disallowed paths are never fetched', async () => {
    const mine = await shopWithProduct(10_000);
    const { targetId } = await crawler.watch(
      mine.shopId,
      mine.productId,
      `${base}/private/deal`,
    );
    await crawler.crawl(targetId);
    expect(hits).toEqual(['/robots.txt']);
    expect((await target(targetId)).lastStatus).toBe('disallowed-by-robots');
  });

  it('an unchanged page (SimHash) skips extraction and backs off its next check', async () => {
    const mine = await shopWithProduct(10_000);
    const { targetId } = await crawler.watch(
      mine.shopId,
      mine.productId,
      `${base}/p/stable`,
    );
    await crawler.crawl(targetId);
    const first = await target(targetId);
    await crawler.crawl(targetId);
    const second = await target(targetId);
    expect(second).toMatchObject({
      lastStatus: 'unchanged',
      unchangedStreak: 1,
    });
    expect(
      new Date(second.nextCheckAt).getTime() -
        new Date(first.nextCheckAt).getTime(),
    ).toBeGreaterThan(5 * 3_600_000);
  });

  it('the frontier allows one in-flight fetch per host and honours Crawl-delay; many watchers share one fetch', async () => {
    const a = await shopWithProduct(10_000);
    const b = await shopWithProduct(10_000);
    const t1 = await crawler.watch(a.shopId, a.productId, `${base}/p/one`);
    const t2 = await crawler.watch(
      b.shopId,
      b.productId,
      `${base}/p/one#reviews`,
    ); // same page, another shop
    await crawler.watch(b.shopId, b.productId, `${base}/p/two`);
    expect(t2.targetId).toBe(t1.targetId);

    expect(await crawler.scheduleDue()).toBe(2); // 2 distinct targets, one host
    expect(await crawler.crawlNext()).toBe(true);
    expect(await crawler.crawlNext()).toBe(false); // host leased + 2 s crawl delay
  });

  it('SSRF: watching an internal address is refused', async () => {
    const mine = await shopWithProduct(10_000);
    await expect(
      crawler.watch(
        mine.shopId,
        mine.productId,
        'https://169.254.169.254/latest/meta-data',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
