import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { productEventSchemas } from '@marketplace-sandbox/contracts';
import {
  ProductQueryService,
  ProductStockService,
  StockOperationConflictError,
} from '@app/domains/catalog';
import {
  createProduct,
  productEvents,
  productRow,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  productEntryExists,
  warmProductEntry,
  type ShopWorld,
} from './testing/catalog-spec-kit';

const PRODUCT_SQL = /"Product"/;

describe('Product query and stock services', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let query: ProductQueryService;
  let stock: ProductStockService;
  let w: ShopWorld;

  const op = (
    over: Partial<{
      operationId: string;
      productId: string;
      shopId: string;
      delta: number;
      reason: string;
    }> = {},
  ) => ({
    operationId: `op-${randomUUID()}`,
    productId: randomUUID(),
    shopId: w.shop.id,
    delta: -1,
    reason: 'checkout',
    ...over,
  });
  const operationRows = (productId?: string) =>
    sequelize.query<{
      operationId: string;
      quantityAfter: number;
      productVersion: number;
    }>(
      `SELECT * FROM "ProductStockOperation" ${productId ? `WHERE "productId" = :productId` : ''} ORDER BY "operationId"`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
    query = t.app.get(ProductQueryService);
    stock = t.app.get(ProductStockService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });

  describe('getProductsByIds (AS-48 to AS-50)', () => {
    it('S05 AS-48: up to 500 ids give a map of ProductDto, archived included, unknown absent, duplicates collapsed, with one statement', async () => {
      const a = await createProduct(t.app, w.shop, {
        quantity: 4,
        version: 3,
        viewCount: 9,
        externalSku: 'E-1',
      });
      const b = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
        isSandbox: true,
      });
      const unknown = randomUUID();

      const { result, statements } = await recordStatements(
        t.app,
        () => query.getProductsByIds([a.id, b.id, a.id, unknown]),
        PRODUCT_SQL,
      );
      expect(statements).toHaveLength(1);
      expect([...result.keys()].sort()).toEqual([a.id, b.id].sort());
      expect(result.get(a.id)).toMatchObject({
        id: a.id,
        shopId: w.shop.id,
        quantity: 4,
        inStock: true,
        status: 'ACTIVE',
        version: 3,
        viewCount: 9,
        isSandbox: false,
        externalSku: 'E-1',
        priceMinor: 10_000,
        currency: 'USD',
      });
      expect(result.get(b.id)).toMatchObject({
        status: 'ARCHIVED',
        isSandbox: true,
      });
      expect(result.get(a.id)!.createdAt).toBeInstanceOf(Date);
    });

    it('S05 AS-48: an empty list is an empty map without a statement; 501 ids and a non-UUID are validation errors', async () => {
      const empty = await recordStatements(
        t.app,
        () => query.getProductsByIds([]),
        PRODUCT_SQL,
      );
      expect(empty.result.size).toBe(0);
      expect(empty.statements).toHaveLength(0);

      const many = Array.from({ length: 501 }, () => randomUUID());
      await expect(query.getProductsByIds(many)).rejects.toMatchObject({
        code: 'validation_failed',
      });
      await expect(query.getProductsByIds(['nope'])).rejects.toMatchObject({
        code: 'validation_failed',
      });
      const max = Array.from({ length: 500 }, () => randomUUID());
      await expect(query.getProductsByIds(max)).resolves.toBeInstanceOf(Map);
    });

    it('S05 AS-49: the current row is returned even while the public entry is stale', async () => {
      const product = await createProduct(t.app, w.shop, {
        priceMinor: 1_000,
        version: 1,
      });
      await t.http().get(`/api/products/${product.id}`).expect(200);
      await sequelize.query(
        `UPDATE "Product" SET "priceMinor" = 2000, "quantity" = 77 WHERE "id" = :id`,
        {
          replacements: { id: product.id },
        },
      );

      const read = await query.getProductsByIds([product.id]);
      expect(read.get(product.id)).toMatchObject({
        priceMinor: 2_000,
        quantity: 77,
      });
      const stale = await t
        .http()
        .get(`/api/products/${product.id}`)
        .expect(200);
      expect(stale.body.priceMinor).toBe(1_000);
    });

    it("S05 AS-50: with {shopId} only that shop's products are returned, the others are absent as if unknown", async () => {
      const other = await createShopWorld(t);
      const mine = await createProduct(t.app, w.shop);
      const theirs = await createProduct(t.app, other.shop);
      const scoped = await query.getProductsByIds([mine.id, theirs.id], {
        shopId: w.shop.id,
      });
      expect([...scoped.keys()]).toEqual([mine.id]);
      const all = await query.getProductsByIds([mine.id, theirs.id]);
      expect(all.size).toBe(2);
    });
  });

  describe('applyStockDelta (AS-51 to AS-57)', () => {
    it('S05 AS-51: a delta is applied: result, row, one operation record, one updated event with changedFields quantity, entry deleted', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 10,
        version: 4,
      });
      await warmProductEntry(t.app, product.id, 4);

      const result = await stock.applyStockDelta([
        {
          operationId: 'o1',
          productId: product.id,
          shopId: w.shop.id,
          delta: -3,
          reason: 'checkout',
        },
      ]);
      expect(result).toEqual({
        outcome: 'applied',
        results: [
          {
            operationId: 'o1',
            productId: product.id,
            quantityAfter: 7,
            productVersion: 5,
            replayed: false,
          },
        ],
      });
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 7,
        version: 5,
      });
      expect(await operationRows(product.id)).toMatchObject([
        { operationId: 'o1', quantityAfter: 7, productVersion: 5 },
      ]);
      const events = await productEvents(t.app, product.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'catalog.product_updated',
        aggregateVersion: 5,
      });
      expect(
        productEventSchemas['catalog.product_updated'].parse(events[0].payload),
      ).toMatchObject({
        changedFields: ['quantity'],
        quantity: 7,
        inStock: true,
        productVersion: 5,
      });
      expect(await productEntryExists(t.app, product.id)).toBe(false);
    });

    it('S05 AS-51: a stock level of zero is reported as not in stock', async () => {
      const product = await createProduct(t.app, w.shop, { quantity: 2 });
      await stock.applyStockDelta([op({ productId: product.id, delta: -2 })]);
      const [event] = await productEvents(t.app, product.id);
      expect(event.payload).toMatchObject({ quantity: 0, inStock: false });
    });

    it('S05 AS-52: a call that cannot be applied in full changes nothing: no row, no operation record, no event', async () => {
      const p = await createProduct(t.app, w.shop, { quantity: 2, version: 1 });
      const q = await createProduct(t.app, w.shop, { quantity: 9, version: 1 });
      const bad = op({ productId: p.id, delta: -3 });
      const result = await stock.applyStockDelta([
        bad,
        op({ productId: q.id, delta: -1 }),
      ]);
      expect(result).toEqual({
        outcome: 'rejected',
        failures: [
          {
            operationId: bad.operationId,
            productId: p.id,
            code: 'insufficient_stock',
          },
        ],
      });
      expect(await productRow(t.app, p.id)).toMatchObject({
        quantity: 2,
        version: 1,
      });
      expect(await productRow(t.app, q.id)).toMatchObject({
        quantity: 9,
        version: 1,
      });
      expect(await operationRows()).toHaveLength(0);
      expect(await productEvents(t.app, p.id)).toHaveLength(0);
      expect(await productEvents(t.app, q.id)).toHaveLength(0);
    });

    it('S05 AS-53: ten concurrent -1 on a stock of 5 apply exactly five; two concurrent -3 on 5 apply exactly one', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 5,
        version: 1,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          stock.applyStockDelta([op({ productId: product.id })]),
        ),
      );
      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(5);
      const rejected = results.filter((r) => r.outcome === 'rejected');
      expect(rejected).toHaveLength(5);
      for (const r of rejected)
        expect(r).toMatchObject({ failures: [{ code: 'insufficient_stock' }] });
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 0,
        version: 6,
      });
      expect(await productEvents(t.app, product.id)).toHaveLength(5);

      const second = await createProduct(t.app, w.shop, { quantity: 5 });
      const pair = await Promise.all([
        stock.applyStockDelta([op({ productId: second.id, delta: -3 })]),
        stock.applyStockDelta([op({ productId: second.id, delta: -3 })]),
      ]);
      expect(pair.map((r) => r.outcome).sort()).toEqual([
        'applied',
        'rejected',
      ]);
      expect(await productRow(t.app, second.id)).toMatchObject({ quantity: 2 });
    });

    it('S05 SC-002: 1,000 concurrent decrements against 100 units accept exactly 100, the stock never drops below zero, and replaying every request changes nothing', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 100,
        version: 1,
      });
      const ops = Array.from({ length: 1_000 }, (_, i) =>
        op({ operationId: `sc2-${i}`, productId: product.id }),
      );
      let lowest = Number.POSITIVE_INFINITY;
      let running = true;
      const watcher = (async () => {
        while (running) {
          const row = await productRow<{ quantity: number }>(t.app, product.id);
          lowest = Math.min(lowest, row!.quantity);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      const first = await Promise.all(
        ops.map((o) => stock.applyStockDelta([o])),
      );
      running = false;
      await watcher;
      expect(first.filter((r) => r.outcome === 'applied')).toHaveLength(100);
      expect(lowest).toBeGreaterThanOrEqual(0);
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 0,
        version: 101,
      });
      const eventsBefore = (await productEvents(t.app, product.id)).length;

      const second = await Promise.all(
        ops.map((o) => stock.applyStockDelta([o])),
      );
      expect(second.filter((r) => r.outcome === 'applied')).toHaveLength(100);
      for (const r of second)
        if (r.outcome === 'applied') expect(r.results[0].replayed).toBe(true);
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 0,
        version: 101,
      });
      expect(await productEvents(t.app, product.id)).toHaveLength(eventsBefore);
      expect(await operationRows(product.id)).toHaveLength(100);
    }, 120_000);

    it('S05 AS-54: replaying an applied operation returns the recorded result and changes nothing; the same id for another product, shop or delta is a conflict', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 10,
        version: 1,
      });
      const other = await createProduct(t.app, w.shop, { quantity: 10 });
      const first = op({ operationId: 'o1', productId: product.id, delta: -4 });
      await stock.applyStockDelta([first]);
      await createProduct(t.app, w.shop); // unrelated write: the replay must still report the original quantity
      await sequelize.query(
        `UPDATE "Product" SET "quantity" = 99 WHERE "id" = :id`,
        {
          replacements: { id: product.id },
        },
      );

      const replay = await stock.applyStockDelta([first]);
      expect(replay).toEqual({
        outcome: 'applied',
        results: [
          {
            operationId: 'o1',
            productId: product.id,
            quantityAfter: 6,
            productVersion: 2,
            replayed: true,
          },
        ],
      });
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 99,
        version: 2,
      });
      expect(await productEvents(t.app, product.id)).toHaveLength(1);
      expect(await operationRows(product.id)).toHaveLength(1);

      for (const changed of [
        { ...first, productId: other.id },
        { ...first, delta: -5 },
        { ...first, shopId: randomUUID() },
      ])
        await expect(stock.applyStockDelta([changed])).rejects.toBeInstanceOf(
          StockOperationConflictError,
        );
      expect(await productRow(t.app, other.id)).toMatchObject({
        quantity: 10,
        version: 1,
      });
    });

    it('S05 AS-55: two identical concurrent calls apply the operation once and the other reports a replay', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 10,
        version: 1,
      });
      const same = op({
        operationId: 'twin',
        productId: product.id,
        delta: -2,
      });
      const [a, b] = await Promise.all([
        stock.applyStockDelta([same]),
        stock.applyStockDelta([same]),
      ]);
      const flags = [a, b].map((r) =>
        r.outcome === 'applied' ? r.results[0].replayed : null,
      );
      expect(flags.sort()).toEqual([false, true]);
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 8,
        version: 2,
      });
      expect(await operationRows(product.id)).toHaveLength(1);
    });

    it('S05 AS-56: an archived product refuses a negative delta and accepts a positive one; an unknown product or another shop is not_found', async () => {
      const archived = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
        quantity: 5,
      });
      const refused = op({ productId: archived.id, delta: -1 });
      expect(await stock.applyStockDelta([refused])).toEqual({
        outcome: 'rejected',
        failures: [
          {
            operationId: refused.operationId,
            productId: archived.id,
            code: 'unavailable',
          },
        ],
      });
      const release = await stock.applyStockDelta([
        op({ productId: archived.id, delta: 2 }),
      ]);
      expect(release.outcome).toBe('applied');
      expect(await productRow(t.app, archived.id)).toMatchObject({
        quantity: 7,
        status: 'ARCHIVED',
      });

      const live = await createProduct(t.app, w.shop, { quantity: 5 });
      const unknown = op({ productId: randomUUID() });
      const foreign = op({ productId: live.id, shopId: randomUUID() });
      const result = await stock.applyStockDelta([unknown, foreign]);
      expect(result).toEqual({
        outcome: 'rejected',
        failures: expect.arrayContaining([
          {
            operationId: unknown.operationId,
            productId: unknown.productId,
            code: 'not_found',
          },
          {
            operationId: foreign.operationId,
            productId: live.id,
            code: 'not_found',
          },
        ]),
      });
      expect(await productRow(t.app, live.id)).toMatchObject({ quantity: 5 });
    });

    const product = () => createProduct(t.app, w.shop, { quantity: 10 });
    it.each([
      ['no operations', async () => []],
      ['101 operations', async () => Array.from({ length: 101 }, () => op())],
      ['a zero delta', async () => [op({ delta: 0 })]],
      ['a fractional delta', async () => [op({ delta: 1.5 })]],
      ['a delta beyond +1,000,000', async () => [op({ delta: 1_000_001 })]],
      ['a delta beyond -1,000,000', async () => [op({ delta: -1_000_001 })]],
      ['an empty operationId', async () => [op({ operationId: '' })]],
      [
        'a 129-character operationId',
        async () => [op({ operationId: 'x'.repeat(129) })],
      ],
      ['a reason with upper case', async () => [op({ reason: 'Checkout' })]],
      ['an empty reason', async () => [op({ reason: '' })]],
      ['a 65-character reason', async () => [op({ reason: 'a'.repeat(65) })]],
      ['a non-UUID product id', async () => [op({ productId: 'nope' })]],
      [
        'the same operationId twice',
        async () => {
          const p = await product();
          return [
            op({ operationId: 'dup', productId: p.id }),
            op({ operationId: 'dup', productId: p.id }),
          ];
        },
      ],
    ])(
      'S05 AS-57: %s is a validation error and changes nothing',
      async (_name, build) => {
        const ops = await build();
        await expect(stock.applyStockDelta(ops)).rejects.toMatchObject({
          code: 'validation_failed',
        });
        expect(await operationRows()).toHaveLength(0);
      },
    );

    it('S05 AS-57: a result above 1,000,000,000 is quantity_limit and changes nothing; the exact limit is accepted', async () => {
      const product = await createProduct(t.app, w.shop, {
        quantity: 999_999_990,
      });
      const over = op({ productId: product.id, delta: 11 });
      expect(await stock.applyStockDelta([over])).toEqual({
        outcome: 'rejected',
        failures: [
          {
            operationId: over.operationId,
            productId: product.id,
            code: 'quantity_limit',
          },
        ],
      });
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 999_999_990,
      });
      const exact = await stock.applyStockDelta([
        op({ productId: product.id, delta: 10 }),
      ]);
      expect(exact.outcome).toBe('applied');
      expect(await productRow(t.app, product.id)).toMatchObject({
        quantity: 1_000_000_000,
      });
    });

    it('S05 AS-51: several operations in one call are applied together; operations on one product make one version step and one event, each with its own record', async () => {
      const p = await createProduct(t.app, w.shop, {
        quantity: 10,
        version: 1,
      });
      const q = await createProduct(t.app, w.shop, {
        quantity: 10,
        version: 1,
      });
      const result = await stock.applyStockDelta([
        op({ productId: p.id, delta: -4 }),
        op({ productId: q.id, delta: 5 }),
        op({ productId: p.id, delta: -6 }),
      ]);
      expect(result.outcome).toBe('applied');
      expect(await productRow(t.app, p.id)).toMatchObject({
        quantity: 0,
        version: 2,
      });
      expect(await productRow(t.app, q.id)).toMatchObject({
        quantity: 15,
        version: 2,
      });
      const events = await productEvents(t.app, p.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ aggregateVersion: 2 });
      expect(
        (await operationRows(p.id)).map((o) => o.quantityAfter).sort(),
      ).toEqual([0, 6]);
      expect(await operationRows(p.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productVersion: 2 }),
        ]),
      );
    });
  });
});
