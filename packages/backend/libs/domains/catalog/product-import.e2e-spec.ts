import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { productEventSchemas } from '@marketplace-sandbox/contracts';
import {
  ProductCommandService,
  ProductImportService,
  ShopNotActiveError,
  VersionConflictError,
  ProductNotFoundError,
} from '@app/domains/catalog';
import {
  createProduct,
  productCount,
  productEvents,
  productRow,
} from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';

const item = (over: Record<string, unknown> = {}) => ({
  externalSku: 'SKU-1',
  title: 'Wool coat',
  description: 'Warm',
  brand: 'Nord',
  category: 'coats',
  priceMinor: 12_900,
  quantity: 5,
  tags: ['Winter'],
  ...over,
});

describe('Product external upsert and commands', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let imports: ProductImportService;
  let commands: ProductCommandService;
  let w: ShopWorld;

  const skuRows = (shopId = w.shop.id, sku = 'SKU-1') =>
    sequelize.query<{
      id: string;
      version: number;
      status: string;
      quantity: number;
      priceMinor: string;
    }>(
      `SELECT "id","version","status","quantity","priceMinor" FROM "Product" WHERE "shopId" = :shopId AND "externalSku" = :sku`,
      { type: QueryTypes.SELECT, replacements: { shopId, sku } },
    );

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
    imports = t.app.get(ProductImportService);
    commands = t.app.get(ProductCommandService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });

  it('S05 AS-60: a new externalSku is created; the identical item is unchanged (no write, no event); a changed price is updated with the changed fields', async () => {
    const [created] = await imports.upsertFromExternal(
      w.shop.id,
      [item()],
      'import',
    );
    expect(created).toMatchObject({
      externalSku: 'SKU-1',
      outcome: 'created',
      productVersion: 1,
    });
    const productId = created.productId!;
    let events = await productEvents(t.app, productId);
    expect(events.map((e) => e.type)).toEqual(['catalog.product_created']);
    expect(
      productEventSchemas['catalog.product_created'].parse(events[0].payload),
    ).toMatchObject({
      externalSku: 'SKU-1',
      tags: ['winter'],
      changedFields: [],
    });

    const [same] = await imports.upsertFromExternal(
      w.shop.id,
      [item()],
      'import',
    );
    expect(same).toMatchObject({
      outcome: 'unchanged',
      productId,
      productVersion: 1,
    });
    expect(await skuRows()).toMatchObject([{ version: 1 }]);
    expect(await productEvents(t.app, productId)).toHaveLength(1);

    const [changed] = await imports.upsertFromExternal(
      w.shop.id,
      [item({ priceMinor: 9_900 })],
      'shopify',
    );
    expect(changed).toMatchObject({
      outcome: 'updated',
      productId,
      productVersion: 2,
    });
    events = await productEvents(t.app, productId);
    expect(events.map((e) => e.type)).toEqual([
      'catalog.product_created',
      'catalog.product_updated',
    ]);
    expect(events[1].payload).toMatchObject({
      changedFields: ['priceMinor'],
      priceMinor: 9_900,
      productVersion: 2,
    });
  });

  it('S05 AS-61: two concurrent upserts of a new externalSku leave exactly one product and no unique violation', async () => {
    const results = await Promise.all([
      imports.upsertFromExternal(w.shop.id, [item()], 'import'),
      imports.upsertFromExternal(
        w.shop.id,
        [item({ title: 'Other title' })],
        'woocommerce',
      ),
    ]);
    expect(await skuRows()).toHaveLength(1);
    const outcomes = results.map(([r]) => r.outcome).sort();
    expect(outcomes[0]).toBe('created');
    expect(['updated', 'unchanged']).toContain(outcomes[1]);
  });

  it('S05 AS-62: valid items are applied and returned, invalid ones come back rejected with their fields, the call does not fail; 0 and 501 items are validation errors', async () => {
    const results = await imports.upsertFromExternal(
      w.shop.id,
      [
        item({ externalSku: 'A' }),
        item({ externalSku: 'B', priceMinor: 0 }),
        item({ externalSku: 'C' }),
        item({ externalSku: 'D', title: 'x'.repeat(201) }),
        item({ externalSku: 'E' }),
      ],
      'import',
    );
    expect(results.map((r) => [r.externalSku, r.outcome])).toEqual([
      ['A', 'created'],
      ['B', 'rejected'],
      ['C', 'created'],
      ['D', 'rejected'],
      ['E', 'created'],
    ]);
    expect(results[1].errors).toEqual([
      { field: 'priceMinor', code: 'invalid' },
    ]);
    expect(results[3].errors).toEqual([{ field: 'title', code: 'invalid' }]);
    expect(await productCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
      3,
    );

    await expect(
      imports.upsertFromExternal(w.shop.id, [], 'import'),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const many = Array.from({ length: 501 }, (_, i) =>
      item({ externalSku: `S${i}` }),
    );
    await expect(
      imports.upsertFromExternal(w.shop.id, many, 'import'),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('S05 AS-63: an archived product is updated but stays archived; an item without quantity leaves stock alone; the same sku in two shops makes two products', async () => {
    const archived = await createProduct(t.app, w.shop, {
      externalSku: 'SKU-1',
      status: 'ARCHIVED',
      quantity: 7,
      version: 3,
      title: 'Old title',
    });
    const { quantity: _quantity, ...withoutQuantity } = item({
      title: 'New title',
    });
    void _quantity;
    const [result] = await imports.upsertFromExternal(
      w.shop.id,
      [withoutQuantity],
      'import',
    );
    expect(result).toMatchObject({
      outcome: 'updated',
      productId: archived.id,
      productVersion: 4,
    });
    expect(await productRow(t.app, archived.id)).toMatchObject({
      status: 'ARCHIVED',
      title: 'New title',
      quantity: 7,
    });

    const other = await createShopWorld(t);
    await imports.upsertFromExternal(other.shop.id, [item()], 'import');
    expect(await skuRows(other.shop.id)).toHaveLength(1);
    expect(await skuRows(w.shop.id)).toHaveLength(1);

    const [carried] = await imports.upsertFromExternal(
      w.shop.id,
      [item({ title: 'New title', quantity: 2 })],
      'import',
    );
    expect(carried.outcome).toBe('updated');
    expect(await productRow(t.app, archived.id)).toMatchObject({ quantity: 2 });
  });

  it('S05 AS-63: an inactive or unknown shop throws ShopNotActiveError before any write', async () => {
    const suspended = await createShopWorld(t, { status: 'SUSPENDED' });
    const deleting = await createShopWorld(t, { status: 'DELETING' });
    for (const shopId of [suspended.shop.id, deleting.shop.id, randomUUID()])
      await expect(
        imports.upsertFromExternal(shopId, [item()], 'import'),
      ).rejects.toBeInstanceOf(ShopNotActiveError);
    expect(await productCount(t.app)).toBe(0);
  });

  it('S05 AS-64: the exported commands refuse a stale version and a foreign product like HTTP does, and write the same row, version and event', async () => {
    const other = await createShopWorld(t);
    const view = await commands.create(w.shop.id, w.staff.id, {
      title: 'Wool coat',
      brand: 'Nord',
      category: 'coats',
      priceMinor: 12_900,
    });
    expect(view).toMatchObject({
      version: 1,
      status: 'ACTIVE',
      shopId: w.shop.id,
    });
    await expect(
      commands.update(
        w.shop.id,
        view.id,
        { expectedVersion: 5, title: 'x' },
        w.staff.id,
      ),
    ).rejects.toMatchObject({ currentVersion: 1 });
    await expect(
      commands.update(
        w.shop.id,
        view.id,
        { expectedVersion: 5, title: 'x' },
        w.staff.id,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      commands.update(
        other.shop.id,
        view.id,
        { expectedVersion: 1, title: 'x' },
        other.staff.id,
      ),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
    await expect(
      commands.getForShop(other.shop.id, view.id),
    ).rejects.toBeInstanceOf(ProductNotFoundError);

    const updated = await commands.update(
      w.shop.id,
      view.id,
      { expectedVersion: 1, priceMinor: 100 },
      w.staff.id,
    );
    const archived = await commands.archive(
      w.shop.id,
      view.id,
      updated.version,
      w.staff.id,
    );
    const restored = await commands.restore(
      w.shop.id,
      view.id,
      archived.version,
      w.staff.id,
    );
    expect(restored).toMatchObject({ status: 'ACTIVE', version: 4 });
    const page = await commands.listByShop(w.shop.id, {});
    expect(page.items.map((p) => p.id)).toEqual([view.id]);
    expect(
      (await productEvents(t.app, view.id)).map((e) => e.aggregateVersion),
    ).toEqual([1, 2, 3, 4]);
  });

  it('S05 AS-64: the HTTP controllers call the exported services and nothing else', () => {
    const dir = join(__dirname, 'api');
    for (const file of [
      'product.controller.ts',
      'public-product.controller.ts',
      'product-batch-read.controller.ts',
    ]) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/from '\.\.\/infra\//);
      expect(source).not.toMatch(/InjectModel|InjectConnection|sequelize/i);
      expect(source).not.toMatch(/@app\/domains\/discovery/);
    }
  });
});
