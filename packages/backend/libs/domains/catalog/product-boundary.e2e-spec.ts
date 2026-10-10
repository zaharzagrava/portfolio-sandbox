import * as catalog from '@app/domains/catalog';
import {
  ProductCommandService,
  ProductImportService,
  ProductModule,
  ProductQueryService,
  ProductStockService,
} from '@app/domains/catalog';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { createShopWorld } from './testing/catalog-spec-kit';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';

/**
 * The runtime names `@app/domains/catalog` exports. Pinned: the list may only shrink (transitional block) or grow with
 * a deliberate edit of this file and of `contracts/services.md`.
 */
const PINNED_EXPORTS = [
  // modules
  'ProductBatchReadModule',
  'ProductModule',
  'ProductProjectorModule',
  'ProductWorkerModule',
  // R1 services
  'ProductCommandService',
  'ProductImportService',
  'ProductQueryService',
  'ProductStockService',
  // policies
  'catalogRatePolicies',
  // error classes
  'CurrencyNotSupportedError',
  'InvalidTransitionError',
  'ProductArchivedError',
  'ProductNotFoundError',
  'ShopNotActiveError',
  'StockOperationConflictError',
  'VersionConflictError',
  // event contracts
  'ProductArchived',
  'ProductCreated',
  'ProductDeleted',
  'ProductRestored',
  'ProductUpdated',
  // TRANSITIONAL block (gaps.md section C)
  'CollabModule',
  'DraftsModule',
  'PRODUCTS_AGGREGATE',
  'ProductChanged',
  'ProductDtoModule',
  'ProductDtoService',
  'ProductModel',
  'ProductService',
  'productChanged',
].sort();

describe('Catalog module boundary', () => {
  it('S05 AS-86: a test module importing only the catalog entry point compiles and resolves every R1 service', async () => {
    const moduleRef = await generateTestingModule([ProductModule], {
      stores: ['redis'],
    });
    try {
      for (const service of [
        ProductCommandService,
        ProductQueryService,
        ProductStockService,
        ProductImportService,
      ])
        expect(moduleRef.get(service, { strict: false })).toBeInstanceOf(
          service,
        );
    } finally {
      await moduleRef.close();
    }
  });

  it('S05 AS-86: the entry point exports exactly the pinned names, and no model-free rule is broken by a new one', () => {
    expect(Object.keys(catalog).sort()).toEqual(PINNED_EXPORTS);
  });

  it('S05 AS-86: the entry point exports no repository, projector, consumer, search or cache-invalidator class', () => {
    const offenders = Object.keys(catalog).filter((name) =>
      /Repository|Projector(?!Module)|Consumer|Search|Invalidator/.test(name),
    );
    expect(offenders).toEqual([]);
  });

  describe('removed search routes (AS-87)', () => {
    let t: CatalogTestApp;
    beforeAll(async () => {
      t = await createCatalogApp();
    });
    afterAll(() => t.close());
    beforeEach(() => t.reset());

    it('S05 AS-87: an application that loads only the catalog modules answers 404 for both search routes', async () => {
      const world = await createShopWorld(t);
      await t.http().get('/api/products/search?q=coat').expect(404);
      await t.as(world.staff).get('/api/products/search?q=coat').expect(404);
      await t
        .as(world.staff)
        .get(`/api/shops/${world.shop.id}/products/search?q=coat`)
        .expect(404);
      await t
        .as(world.viewer)
        .get(`/api/shops/${world.shop.id}/products/search?q=coat`)
        .expect(404);
    });
  });
});
