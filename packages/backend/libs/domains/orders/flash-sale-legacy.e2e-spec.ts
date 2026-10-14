import { randomUUID } from 'node:crypto';
import { ProductStockService } from '@app/domains/catalog';
import { rows, stockOf } from './testing/orders-app';
import {
  createFlashApp,
  seedSeller,
  type FlashTestApp,
} from './testing/flash-kit';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);

/**
 * Replaces the S10 T078 spec of the parked flash jobs (deleted with `infra/flash/`, L-017): the same three
 * behaviors, now proven on the S11 sale created through the route. The full lifecycle is in flash-sale-lifecycle.e2e-spec.ts.
 */
describe('Flash sales: stock moves only through the catalog on load and return (replaces S10 T078)', () => {
  let t: FlashTestApp;

  beforeAll(async () => {
    t = await createFlashApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  const schedule = async (units: number) => {
    const s = await seedSeller(t, [{ priceMinor: 1_000, quantity: 20 }]);
    const res = await t
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/flash-sales`)
      .send({
        productId: s.products[0].id,
        priceMinor: 500,
        units,
        buckets: 2,
        perUserLimit: 2,
        startsAt: at(10 * MIN).toISOString(),
        endsAt: at(70 * MIN).toISOString(),
      });
    expect(res.status).toBe(201);
    return { saleId: res.body.id as string, product: s.products[0] };
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

  it('S11 AS-20 AS-21: the load takes the units out under orders:flash:<saleId>:load and a repeat does not take them twice', async () => {
    const { saleId, product } = await schedule(5);
    t.clock.set(at(9 * MIN));
    await t.jobs.load({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 15 });
    expect(await status(saleId)).toBe('LOADED');
    await t.jobs.load({ saleId }); // LOADED now: nothing to do
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 15 });
    expect((await operations(saleId)).map((o) => o.operationId)).toEqual([
      `orders:flash:${saleId}:load`,
    ]);
  });

  it('S11 AS-22: a sale that asks for more units than the stock fails without changing it', async () => {
    const { saleId, product } = await schedule(15);
    // another sale takes 10 units after the schedule: 10 are left for 15 asked
    await t.app.get(ProductStockService).applyStockDelta([
      {
        operationId: `test:${randomUUID()}`,
        productId: product.id,
        shopId: product.shopId,
        delta: -10,
        reason: 'test.sale',
      },
    ]);
    t.clock.set(at(9 * MIN));
    await t.jobs.load({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 10 });
    expect(await status(saleId)).toBe('START_FAILED');
    expect(await operations(saleId)).toEqual([]);
  });

  it('S11 AS-25: reconcile returns the unsold units under orders:flash:<saleId>:return, once', async () => {
    const { saleId, product } = await schedule(5);
    t.clock.set(at(9 * MIN));
    await t.jobs.load({ saleId });
    t.clock.set(at(70 * MIN));
    await t.jobs.end({ saleId });
    t.clock.set(at(86 * MIN));
    await t.jobs.reconcile({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 20 });
    expect(await status(saleId)).toBe('RECONCILED');
    await t.jobs.reconcile({ saleId });
    expect(await stockOf(t.app, [product.id])).toEqual({ [product.id]: 20 });
    expect((await operations(saleId)).map((o) => o.operationId)).toEqual([
      `orders:flash:${saleId}:load`,
      `orders:flash:${saleId}:return`,
    ]);
  });
});
