import {
  CollabModule,
  DraftsModule,
  ProductModule,
} from '@app/domains/catalog';
import {
  draftConnectSchema,
  draftSchema,
} from '@marketplace-sandbox/contracts';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import { announceRing } from './testing/draft-spec-kit';

/**
 * R1 usage proof (S06 T068): an application that imports only the modules of the catalog entry point, next to the real
 * tenancy and product modules, creates a draft from a product and connects to it. The draft code reaches products and
 * membership through the exported services alone.
 */
describe('Drafts through the catalog entry point', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [ProductModule, DraftsModule, CollabModule],
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
    await announceRing(t.app);
  });

  it('S06 AS-02: a draft is created from a product of the shop and a member connects to it, with the entry point modules only', async () => {
    const product = await createProduct(t.app, w.shop, {
      version: 4,
      brand: 'Acme',
      category: 'tools',
    });
    const created = await t
      .as(w.staff)
      .post(`/api/shops/${w.shop.id}/drafts`)
      .send({ title: 'Rework', productId: product.id })
      .expect(201);
    const draft = draftSchema.parse(created.body);
    expect(draft).toMatchObject({
      productId: product.id,
      baseProductVersion: 4,
      status: 'DRAFT',
    });

    const connect = await t
      .as(w.viewer)
      .post(`/api/shops/${w.shop.id}/drafts/${draft.id}/connect`)
      .expect(200);
    expect(draftConnectSchema.parse(connect.body).canWrite).toBe(false);
  });
});
