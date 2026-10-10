import { randomUUID as v4 } from 'crypto';
import { ApiConfigService } from '@app/common/config';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';

/**
 * The original `Product (e2e)` cases. Reading a product by id is still served by the catalog
 * (`GET /api/products/:id`, deeper cases in `product-read.e2e-spec.ts`). Search moved out of the catalog (its
 * routes are served by S32), so the search cases keep their assertions but call the search adapter,
 * `ElasticsearchService.searchProducts`, which is what `/api/products/search` delegated to.
 */
describe('Product (e2e)', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let esService: ElasticsearchService;

  beforeAll(async () => {
    t = await createCatalogApp();
    esService = new ElasticsearchService(t.app.get(ApiConfigService));
  });

  afterAll(() => t.close());

  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
    // Clean ES properly by getting concrete index name
    try {
      const aliases = await esService
        .getClient()
        .indices.getAlias({ name: 'products' });
      const indices = Object.keys(aliases);
      if (indices.length > 0) {
        await esService.getClient().indices.delete({ index: indices });
      }
    } catch (e) {
      console.log('ES cleanup error (likely not found)', e);
    }
    await esService.ensureProductsIndex();
  });

  it('retrieves a product by ID', async () => {
    const product = await createProduct(t.app, w.shop, {
      title: 'Test Product 123',
    });

    const res = await t.http().get(`/api/products/${product.id}`).expect(200);

    expect(res.body.id).toBe(product.id);
    expect(res.body.title).toBe('Test Product 123');
    expect(res.body.shopId).toBe(w.shop.id);
    expect(res.headers.etag).toBe(`W/"${product.id}-v${product.version}"`);
  });

  it('returns 404 for non-existent product', async () => {
    const res = await t.http().get(`/api/products/${v4()}`).expect(404);

    expect(res.headers['content-type']).toContain('problem+json');
    expect(res.body.status).toBe(404);
  });

  it('searches for products and respects pagination', async () => {
    const titles = ['Apple iPhone', 'Apple iPad', 'Samsung Galaxy'];
    const ids = titles.map(() => v4());
    await esService.bulkUpsertProducts(
      titles.map((title, i) => ({
        id: ids[i],
        title,
        embedding: esService.stubEmbed(title),
      })) as any,
      { refresh: true },
    );

    const res = await esService.searchProducts({ q: 'Apple' });

    expect(res.hits).toHaveLength(2);
    expect(res.hits.some((h: any) => h.id === ids[0])).toBe(true);
    expect(res.hits.some((h: any) => h.id === ids[1])).toBe(true);
    expect(res.total).toBe(2);

    const page = await esService.searchProducts({ q: 'Apple', size: 1 });
    expect(page.hits).toHaveLength(1);
    expect(page.total).toBe(2);
    const next = await esService.searchProducts({
      q: 'Apple',
      size: 1,
      from: 1,
    });
    expect(next.hits).toHaveLength(1);
    expect(next.hits[0].id).not.toBe(page.hits[0].id);
  });

  describe('search filters and sorting', () => {
    beforeEach(async () => {
      const docs = [
        { title: 'Cheap Phone', price: 10000, rating: 3.5, at: '2026-01-01' },
        { title: 'Mid Phone', price: 30000, rating: 4.2, at: '2026-01-05' },
        {
          title: 'Expensive Phone',
          price: 80000,
          rating: 4.8,
          at: '2026-01-10',
        },
      ];
      await esService.bulkUpsertProducts(
        docs.map((d) => ({
          id: v4(),
          title: d.title,
          price: d.price,
          rating: d.rating,
          createdAt: new Date(d.at).toISOString(),
          embedding: esService.stubEmbed(d.title),
        })) as any,
        { refresh: true },
      );
    });

    const titlesOf = (res: { hits: any[] }) =>
      res.hits.map((h) => h.source.title);

    it('filters by price range', async () => {
      const res = await esService.searchProducts({
        priceMin: 20000,
        priceMax: 50000,
      });

      expect(res.hits).toHaveLength(1);
      expect(res.hits[0].source.title).toBe('Mid Phone');
    });

    it('filters by rating', async () => {
      const res = await esService.searchProducts({ ratingMin: 4.0 });

      expect(res.hits).toHaveLength(2);
      expect(titlesOf(res)).toContain('Mid Phone');
      expect(titlesOf(res)).toContain('Expensive Phone');
    });

    it('sorts by price-asc', async () => {
      const res = await esService.searchProducts({ sort: 'price-asc' });

      expect(res.hits).toHaveLength(3);
      expect(res.hits[0].source.title).toBe('Cheap Phone');
      expect(res.hits[1].source.title).toBe('Mid Phone');
      expect(res.hits[2].source.title).toBe('Expensive Phone');
    });

    it('sorts by price-desc', async () => {
      const res = await esService.searchProducts({ sort: 'price-desc' });

      expect(res.hits).toHaveLength(3);
      expect(res.hits[0].source.title).toBe('Expensive Phone');
      expect(res.hits[1].source.title).toBe('Mid Phone');
      expect(res.hits[2].source.title).toBe('Cheap Phone');
    });

    it('sorts by newest', async () => {
      const res = await esService.searchProducts({ sort: 'newest' });

      expect(res.hits).toHaveLength(3);
      expect(res.hits[0].source.title).toBe('Expensive Phone');
      expect(res.hits[1].source.title).toBe('Mid Phone');
      expect(res.hits[2].source.title).toBe('Cheap Phone');
    });
  });
});
