import { randomUUID as v4 } from 'crypto';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';

/**
 * The original `Product (e2e)` cases. Reading a product by id is still served by the catalog
 * (`GET /api/products/:id`, deeper cases in `product-read.e2e-spec.ts`). The search cases moved to S32
 * (`discovery/search-query.e2e-spec.ts`), which proves them over HTTP.
 */
describe('Product (e2e)', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    t = await createCatalogApp();
  });

  afterAll(() => t.close());

  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
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
});
