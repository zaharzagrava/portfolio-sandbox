import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { createCatalogApp, type CatalogTestApp } from '@app/test/utils/catalog-app';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { ShopProductSearchService } from './application/shop-product-search.service';
import { SearchAdminModule } from './search-admin.module';

/**
 * Cases of the old `search-reindex.e2e-spec.ts` that belong to stories this pass does not build: search-time synonyms
 * (S32 US6, `search-synonyms.e2e-spec.ts`) and the seller's product search (US7, `shop-product-search.e2e-spec.ts`).
 * They keep running against the code that still serves them; the pass that builds those stories moves each case into
 * its own spec and deletes this file.
 */
describe('Search features awaiting their stories (transitional)', () => {
  let t: CatalogTestApp;
  let es: ElasticsearchService;

  beforeAll(async () => {
    t = await createCatalogApp({ extraImports: [SearchAdminModule] });
    es = new ElasticsearchService(t.app.get(ApiConfigService));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    const names = Object.keys(
      await es
        .getClient()
        .indices.get({ index: 'products*', expand_wildcards: 'all', ignore_unavailable: true })
        .catch(() => ({})),
    );
    if (names.length > 0)
      await es.getClient().indices.delete({ index: names, ignore_unavailable: true });
  });

  it('search-time synonyms: "earbuds" finds AirPods without reindexing', async () => {
    await es.ensureProductsIndex();
    await es.bulkUpsertProducts(
      [
        {
          id: v4(),
          title: 'AirPods Pro',
          embedding: es.stubEmbed('AirPods Pro'),
        } as never,
      ],
      { refresh: true },
    );
    await es.updateSynonyms(['airpods, earbuds']);
    const { hits } = await es.searchProducts({ q: 'earbuds' });
    expect(hits.map((h) => h.source.title)).toContain('AirPods Pro');
  });

  it('shop-admin search is shop-scoped, fresh, and typo tolerant', async () => {
    const shopA = await createShop(t.app, null);
    const shopB = await createShop(t.app, null);
    await createProduct(t.app, shopA, { title: 'iPhone 17 Pro Case' });
    await createProduct(t.app, shopB, { title: 'iPhone 17 Pro Case' });
    const search = t.app.get(ShopProductSearchService, { strict: false });
    expect(await search.search(shopA.id, 'iphone case')).toHaveLength(1);
    expect(
      (await search.search(shopA.id, 'iphnoe cse')).map((h) => h.title),
    ).toEqual(['iPhone 17 Pro Case']);
    expect((await search.search(shopA.id, '')).map((h) => h.title)).toEqual([
      'iPhone 17 Pro Case',
    ]); // empty query = the shop's list
  });
});
