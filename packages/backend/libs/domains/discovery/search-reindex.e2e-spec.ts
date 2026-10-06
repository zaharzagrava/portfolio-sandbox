import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ElasticsearchService, PRODUCTS_INDEX } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { SearchReindexWorkerModule } from './search-reindex-worker.module';
import { SearchReindexService } from './application/search-reindex.service';
import { ShopProductSearchService } from './application/shop-product-search.service';

@Module({ imports: [SearchReindexWorkerModule, SequelizeModule.forFeature([Shop])], providers: [ShopProductSearchService] })
class SpecModule {}

/** SD-37 against real Elasticsearch + Postgres. */
describe('Search reindex & shop search (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let es: ElasticsearchService;
  let reindex: SearchReindexService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule]);
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    es = app.get(ElasticsearchService);
    reindex = app.get(SearchReindexService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    await es.getClient().indices.delete({ index: `${PRODUCTS_INDEX}*` }).catch(() => undefined);
    await es.getClient().indices.deleteAlias({ index: '_all', name: PRODUCTS_INDEX }).catch(() => undefined);
  });

  it('migrates a legacy concrete index to an alias, and search never sees an empty index', async () => {
    await es.getClient().indices.create({ index: PRODUCTS_INDEX }); // pre-SD-37 deployment
    await seeds.createTreelike([{ __type__: TableName.Product, title: 'iPhone 17' }, { __type__: TableName.Product, title: 'AirPods Pro' }]);

    const first = await reindex.reindex({ batchSize: 1 }); // forces keyset pagination
    expect(first.documents).toBe(2);
    expect(Object.keys(await es.getClient().indices.getAlias({ name: PRODUCTS_INDEX }))).toEqual([first.index]);

    // Search keeps answering during a second rebuild: poll while it runs.
    let minCount = Infinity;
    const poll = setInterval(async () => {
      const { count } = await es.getClient().count({ index: PRODUCTS_INDEX }).catch(() => ({ count: -1 }));
      minCount = Math.min(minCount, count);
    }, 5);
    const second = await reindex.reindex({});
    clearInterval(poll);
    expect(minCount).toBe(2);
    expect(Object.keys(await es.getClient().indices.getAlias({ name: PRODUCTS_INDEX }))).toEqual([second.index]);
    expect(await es.getClient().indices.exists({ index: first.index })).toBe(true); // kept for rollback
  });

  it('search-time synonyms: "earbuds" finds AirPods without reindexing', async () => {
    await seeds.createTreelike([{ __type__: TableName.Product, title: 'AirPods Pro' }]);
    await reindex.reindex({});
    await es.updateSynonyms(['airpods, earbuds']);
    const { hits } = await es.searchProducts({ q: 'earbuds' });
    expect(hits.map((h) => h.source.title)).toContain('AirPods Pro');
  });

  it('shop-admin search is shop-scoped, fresh, and typo tolerant', async () => {
    const shops = app.get<typeof Shop>(getModelToken(Shop));
    const shopA = (await shops.create({ name: 'A', slug: `a-${v4().slice(0, 8)}` })).id;
    const shopB = (await shops.create({ name: 'B', slug: `b-${v4().slice(0, 8)}` })).id;
    await seeds.createTreelike([
      { __type__: TableName.Product, title: 'iPhone 17 Pro Case', shopId: shopA },
      { __type__: TableName.Product, title: 'iPhone 17 Pro Case', shopId: shopB },
    ]);
    const search = app.get(ShopProductSearchService);
    expect(await search.search(shopA, 'iphone case')).toHaveLength(1);
    expect((await search.search(shopA, 'iphnoe cse')).map((h) => h.title)).toEqual(['iPhone 17 Pro Case']);
    expect((await search.search(shopA, '')).map((h) => h.title)).toEqual(['iPhone 17 Pro Case']); // empty query = the shop's list
  });
});
