import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { OWNERSHIP } from '../../../db/ownership';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';

describe('Product and shop lifecycle', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;

  const rows = <T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('storage backstop (schema)', () => {
    it('S05 AS-58: the database refuses a negative quantity and a quantity above 1,000,000,000', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const product = await createProduct(t.app, shop, { quantity: 3 });

      await expect(
        createProduct(t.app, shop, { quantity: -1 }),
      ).rejects.toThrow(/Product_quantity_check/);
      await expect(
        createProduct(t.app, shop, { quantity: 1_000_000_001 }),
      ).rejects.toThrow(/Product_quantity_check/);
      await expect(
        sequelize.query(
          `UPDATE "Product" SET "quantity" = -1 WHERE "id" = :id`,
          { replacements: { id: product.id } },
        ),
      ).rejects.toThrow(/Product_quantity_check/);

      const [kept] = await rows<{ quantity: number }>(
        `SELECT "quantity" FROM "Product" WHERE "id" = :id`,
        { id: product.id },
      );
      expect(kept.quantity).toBe(3);
    });

    it('S05 AS-58: the database refuses a second product with the same (shopId, externalSku) and allows it in another shop', async () => {
      const owner = await t.newUser();
      const shopA = await createShop(t.app, owner);
      const shopB = await createShop(t.app, owner);
      await createProduct(t.app, shopA, { externalSku: 'SKU-1' });

      await expect(
        createProduct(t.app, shopA, { externalSku: 'SKU-1' }),
      ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
      await createProduct(t.app, shopB, { externalSku: 'SKU-1' });
      await createProduct(t.app, shopA, { externalSku: null });
      await createProduct(t.app, shopA, { externalSku: null });
    });

    it('S05 AS-58: the database refuses a version below 1 and an unknown status', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      await expect(createProduct(t.app, shop, { version: 0 })).rejects.toThrow(
        /Product_version_check/,
      );
      await expect(
        createProduct(t.app, shop, { status: 'DELETED' as 'ACTIVE' }),
      ).rejects.toThrow(/Product_status_check/);
    });

    it('S05 AS-58: price and priceMinor stay equal whichever one a legacy writer sets', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const id = '0198a000-0000-7000-8000-000000000001';
      await sequelize.query(
        `INSERT INTO "Product" ("id","shopId","title","description","brand","category","price","createdAt","updatedAt")
         VALUES (:id, :shopId, 'Legacy', 'd', 'b', 'c', 4200, now(), now())`,
        { replacements: { id, shopId: shop.id } },
      );
      const [inserted] = await rows<{
        price: string;
        priceMinor: string;
        version: number;
        status: string;
        currency: string;
      }>(`SELECT * FROM "Product" WHERE "id" = :id`, { id });
      expect(inserted).toMatchObject({
        price: '4200',
        priceMinor: '4200',
        version: 1,
        status: 'ACTIVE',
      });

      await sequelize.query(
        `UPDATE "Product" SET "price" = 5000 WHERE "id" = :id`,
        { replacements: { id } },
      );
      await sequelize.query(
        `UPDATE "Product" SET "priceMinor" = 6000 WHERE "id" = :id`,
        { replacements: { id } },
      );
      const [updated] = await rows<{ price: string; priceMinor: string }>(
        `SELECT "price","priceMinor" FROM "Product" WHERE "id" = :id`,
        { id },
      );
      expect(updated).toEqual({ price: '6000', priceMinor: '6000' });
    });
  });

  describe('ownership constraints (schema)', () => {
    const NEW_TABLES = [
      'ProductStatusHistory',
      'ProductStockOperation',
      'ProductShopState',
      'ProductViewBatch',
    ];

    it('S05 AS-80: the four new tables exist and carry no foreign key', async () => {
      const found = await rows<{ name: string }>(
        `SELECT table_name::text AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN (:names)`,
        { names: NEW_TABLES },
      );
      expect(found.map((r) => r.name).sort()).toEqual([...NEW_TABLES].sort());
      const foreignKeys = await rows<{ conrelid: string }>(
        `SELECT conrelid::regclass::text AS conrelid FROM pg_constraint
         WHERE contype = 'f' AND conrelid::regclass::text IN (:quoted)`,
        { quoted: NEW_TABLES.map((n) => `"${n}"`).concat(NEW_TABLES) },
      );
      expect(foreignKeys).toEqual([]);
    });

    it('S05 AS-80: the ownership registry lists Product and its four tables as domain:catalog', () => {
      for (const name of ['Product', ...NEW_TABLES])
        expect((OWNERSHIP as Record<string, string>)[name]).toBe(
          'domain:catalog',
        );
    });
  });
});
