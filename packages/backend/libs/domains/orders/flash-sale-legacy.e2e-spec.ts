import { randomUUID } from 'node:crypto';
import { rows, exec } from './testing/orders-app';
import { FlashSaleJobs } from './infra/flash/flash-sale.jobs';
import {
  createOrdersApp,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

describe('Orders: parked flash-sale jobs move stock only through the catalog (S10 T078)', () => {
  let t: OrdersTestApp;
  let jobs: FlashSaleJobs;

  beforeAll(async () => {
    t = await createOrdersApp();
    jobs = t.app.get(FlashSaleJobs, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const schedule = async (units: number) => {
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 1_000, quantity: 20 },
    ]);
    const saleId = randomUUID();
    const now = t.clock.now();
    await exec(
      t.app,
      `INSERT INTO "FlashSale" ("id", "productId", "shopId", "price", "units", "buckets", "perUserLimit", "startsAt", "endsAt", "status", "createdAt", "updatedAt")
       VALUES (:saleId, :productId, :shopId, 500, :units, 2, 2, :startsAt, :endsAt, 'SCHEDULED', :now, :now)`,
      {
        saleId,
        productId: products[0].id,
        shopId: shop.id,
        units,
        startsAt: new Date(now.getTime() + 60_000),
        endsAt: new Date(now.getTime() + 3_600_000),
        now,
      },
    );
    return { saleId, product: products[0] };
  };
  const status = async (saleId: string) =>
    (
      await rows<{ status: string }>(
        t.app,
        `SELECT "status" FROM "FlashSale" WHERE "id" = :saleId`,
        { saleId },
      )
    )[0].status;
  const operations = (saleId: string) =>
    rows<{ operationId: string; delta: number }>(
      t.app,
      `SELECT "operationId", "delta" FROM "ProductStockOperation" WHERE "operationId" LIKE :like ORDER BY "operationId"`,
      { like: `orders:flash:${saleId}:%` },
    );

  it('S10 T078: start takes the units out under orders:flash:<saleId>:load and a repeat does not take them twice', async () => {
    const { saleId, product } = await schedule(5);
    await jobs.start({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 15 });
    expect(await status(saleId)).toBe('LIVE');
    await jobs.start({ saleId }); // LIVE now: nothing to do
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 15 });
    expect((await operations(saleId)).map((o) => o.operationId)).toEqual([
      `orders:flash:${saleId}:load`,
    ]);
  });

  it('S10 T078: a sale that asks for more units than the stock fails without changing it', async () => {
    const { saleId, product } = await schedule(500);
    await expect(jobs.start({ saleId })).rejects.toThrow(/not enough stock/);
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 20 });
    expect(await status(saleId)).toBe('SCHEDULED');
  });

  it('S10 T078: reconcile returns the unsold units under orders:flash:<saleId>:return, once', async () => {
    const { saleId, product } = await schedule(5);
    await jobs.start({ saleId });
    await jobs.end({ saleId });
    await jobs.reconcile({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 20 });
    expect(await status(saleId)).toBe('RECONCILED');
    await jobs.reconcile({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 20 });
    expect((await operations(saleId)).map((o) => o.operationId)).toEqual([
      `orders:flash:${saleId}:load`,
      `orders:flash:${saleId}:return`,
    ]);
  });
});
