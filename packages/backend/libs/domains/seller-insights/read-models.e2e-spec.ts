import { getModelToken } from '@nestjs/sequelize';
import { v4 as uuidv4 } from 'uuid';
import { ShopModel } from '@app/domains/tenancy';
import {
  ShopErasureProjector,
  ShopNameProjector,
  ProductCategoryProjector,
} from './infra/projectors/read-model.projectors';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
} from './testing/insights-fixtures';

describe('Seller insights: shop and product read models, shop deletion', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const shopRow = async (shopId: string) =>
    (
      await t.pg<{ name: string; slug: string; shopVersion: number }>(
        `SELECT "name", "slug", "shopVersion" FROM "SellerInsightsShop" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0];
  const productRow = async (productId: string) =>
    (
      await t.pg<{
        category: string | null;
        productVersion: number;
        shopId: string;
      }>(
        `SELECT "category", "productVersion", "shopId" FROM "SellerInsightsProduct" WHERE "productId" = :productId`,
        { productId },
      )
    )[0];

  describe('AS-58: shop read model consumer', () => {
    it('S40 AS-58: delivered in the order 2, 1, 1 the model holds Alpha Plus at version 2, without an error', async () => {
      const shopId = uuidv4();
      const created = t.shopCreated({
        shopId,
        name: 'Alpha',
        slug: 'alpha',
        shopVersion: 1,
      });
      const renamed = t.shopUpdated({
        shopId,
        name: 'Alpha Plus',
        slug: 'alpha',
        shopVersion: 2,
      });
      const consumer = t.projector(ShopNameProjector);

      const first = await t.deliver(consumer, [renamed]);
      const second = await t.deliver(consumer, [created]);
      const third = await t.deliver(consumer, [created]);

      expect([first, second, third].flatMap((r) => r.deadLettered)).toEqual([]);
      expect(await shopRow(shopId)).toMatchObject({
        name: 'Alpha Plus',
        slug: 'alpha',
        shopVersion: 2,
      });
    });

    it('S40 AS-58: a message with a missing shopId or a non-integer shopVersion is dead-lettered and changes nothing', async () => {
      const shopId = uuidv4();
      const consumer = t.projector(ShopNameProjector);
      await t.deliver(consumer, [
        t.shopCreated({ shopId, name: 'Alpha', slug: 'alpha', shopVersion: 1 }),
      ]);

      const noShop = t.raw('tenancy.shop_updated', 'tenancy', shopId, {
        name: 'X',
        slug: 'x',
        shopVersion: 5,
      });
      const badVersion = t.raw('tenancy.shop_updated', 'tenancy', shopId, {
        shopId,
        name: 'Y',
        slug: 'y',
        shopVersion: 1.5,
      });
      const result = await t.deliver(consumer, [noShop, badVersion]);

      expect(result.deadLettered.map((d) => d.event.eventId).sort()).toEqual(
        [noShop.eventId, badVersion.eventId].sort(),
      );
      expect(
        result.deadLettered.every((d) => d.reason === 'INVALID_PAYLOAD'),
      ).toBe(true);
      expect(await shopRow(shopId)).toMatchObject({
        name: 'Alpha',
        shopVersion: 1,
      });
    });
  });

  describe('AS-59: product read model consumer', () => {
    it('S40 AS-59: delivered in the order 3, 1, 2, 3 the model holds tablets at version 3; a deletion keeps the category', async () => {
      const productId = uuidv4();
      const shopId = uuidv4();
      const consumer = t.projector(ProductCategoryProjector);
      const v1 = t.productEvent('created', {
        productId,
        shopId,
        category: 'electronics',
        productVersion: 1,
      });
      const v2 = t.productEvent('updated', {
        productId,
        shopId,
        category: 'phones',
        productVersion: 2,
      });
      const v3 = t.productEvent('updated', {
        productId,
        shopId,
        category: 'tablets',
        productVersion: 3,
      });

      const results = [
        await t.deliver(consumer, [v3]),
        await t.deliver(consumer, [v1]),
        await t.deliver(consumer, [v2]),
        await t.deliver(consumer, [v3]),
      ];

      expect(results.flatMap((r) => r.deadLettered)).toEqual([]);
      expect(await productRow(productId)).toMatchObject({
        category: 'tablets',
        productVersion: 3,
        shopId,
      });

      await t.deliver(consumer, [
        t.productDeleted({ productId, shopId, productVersion: 4 }),
      ]);
      expect(await productRow(productId)).toMatchObject({
        category: 'tablets',
        productVersion: 4,
      });
    });

    it('S40 AS-59: a message without productId is dead-lettered and changes nothing', async () => {
      const consumer = t.projector(ProductCategoryProjector);
      const bad = t.raw('catalog.product_updated', 'products', uuidv4(), {
        shopId: uuidv4(),
        category: 'x',
        productVersion: 2,
      });

      const result = await t.deliver(consumer, [bad]);

      expect(result.deadLettered).toHaveLength(1);
      expect(result.deadLettered[0].reason).toBe('INVALID_PAYLOAD');
      expect(await t.pg(`SELECT 1 FROM "SellerInsightsProduct"`)).toHaveLength(
        0,
      );
    });
  });

  describe('AS-60: a deleted shop leaves every store', () => {
    it('S40 AS-60: after shop_deleted the shop is on no board, in no snapshot row, counter, analytics row or read model; the others are unchanged; a repeat changes nothing', async () => {
      const a = await t.seedShop({ name: 'Alpha' });
      const b = await t.seedShop({ name: 'Beta' });
      const c = await t.seedShop({ name: 'Gamma' });
      const pa = await t.product(a.shopId, 'electronics');
      const pb = await t.product(b.shopId, 'electronics');
      const pc = await t.product(c.shopId, 'electronics');
      // two weeks and two months: 2026-W40 (month 2026-09) and 2026-W41 (month 2026-10)
      const w40 = '2026-09-30T10:00:00Z';
      const w41 = '2026-10-06T11:59:30Z';
      const orders = [
        t.paid({
          paidAt: w40,
          lines: [{ productId: pa, shopId: a.shopId, lineTotalMinor: 30_000 }],
        }),
        t.paid({
          paidAt: w40,
          lines: [{ productId: pb, shopId: b.shopId, lineTotalMinor: 20_000 }],
        }),
        t.paid({
          paidAt: w40,
          lines: [{ productId: pc, shopId: c.shopId, lineTotalMinor: 10_000 }],
        }),
        t.paid({
          paidAt: w41,
          lines: [
            {
              productId: pa,
              shopId: a.shopId,
              lineTotalMinor: 5_000,
              quantity: 2,
            },
          ],
        }),
        t.paid({
          paidAt: w41,
          lines: [{ productId: pb, shopId: b.shopId, lineTotalMinor: 4_000 }],
        }),
      ];
      await t.deliverOrders([
        ...orders,
        t.reserved({ shopIds: [a.shopId, b.shopId] }),
      ]);
      t.clock.set(new Date('2026-10-05T01:00:00Z'));
      await t.freeze('2026-W40');
      t.clock.set(T0);
      expect(
        (await t.snapshotRows('2026-W40')).map((r) => [r.rank, r.shopId]),
      ).toEqual([
        [1, a.shopId],
        [2, b.shopId],
        [3, c.shopId],
      ]);
      const second = Math.floor(T0.getTime() / 1000);
      const bucketsBefore = (
        await t.counters().window(a.shopId, second)
      ).reduce((n, x) => n + x.orders + x.checkouts, 0);
      expect(bucketsBefore).toBeGreaterThan(0);
      const statsBefore = await t
        .as(a.owner)
        .get(`/api/shops/${a.shopId}/stats?days=7`)
        .expect(200);
      const bStatsBefore = (
        await t
          .as(b.owner)
          .get(`/api/shops/${b.shopId}/stats?days=7`)
          .expect(200)
      ).body;
      const bBoardBefore = await t.board(t.week(), 'all');
      expect(statsBefore.body.summary).toMatchObject({
        orders: 2,
        revenueMinor: 35_000,
        unitsSold: 3,
      });

      const erasure = t.projector(ShopErasureProjector);
      const names = t.projector(ShopNameProjector);
      const deleted = t.shopDeleted(a.shopId);
      await t.deliver(erasure, [deleted]);
      await t.deliver(names, [deleted]);

      // live boards: no entry, no revenue or last-sale field, in any period or category
      for (const period of [
        t.week('2026-W40'),
        t.week('2026-W41'),
        t.month('2026-09'),
        t.month('2026-10'),
      ]) {
        expect(
          (await t.board(period, 'all')).map((e) => e.shopId),
        ).not.toContain(a.shopId);
        expect(
          (await t.board(period, 'cat:electronics')).map((e) => e.shopId),
        ).not.toContain(a.shopId);
        expect(
          await t.redis.hexists(`lb:{${period.id}}:rev`, `all|${a.shopId}`),
        ).toBe(0);
        expect(
          await t.redis.hexists(
            `lb:{${period.id}}:rev`,
            `cat:electronics|${a.shopId}`,
          ),
        ).toBe(0);
        expect(
          await t.redis.hexists(`lb:{${period.id}}:last`, `all|${a.shopId}`),
        ).toBe(0);
      }
      // snapshot: its rows are gone and the rest is renumbered
      expect(
        (await t.snapshotRows('2026-W40')).map((r) => [
          r.rank,
          r.shopId,
          r.participants,
        ]),
      ).toEqual([
        [1, b.shopId, 2],
        [2, c.shopId, 2],
      ]);
      expect(
        (await t.snapshotRows('2026-W40', 'cat:electronics')).map((r) => [
          r.rank,
          r.shopId,
        ]),
      ).toEqual([
        [1, b.shopId],
        [2, c.shopId],
      ]);
      // dashboard counters, analytics, read models
      expect(
        (await t.counters().window(a.shopId, second)).reduce(
          (n, x) => n + x.orders + x.checkouts,
          0,
        ),
      ).toBe(0);
      expect(
        await t.sql(
          `SELECT count() AS n FROM shop_sale_facts WHERE shop_id = {id:String}`,
          { id: a.shopId },
        ),
      ).toEqual([{ n: '0' }]);
      expect(
        await t.sql(
          `SELECT count() AS n FROM shop_refund_facts WHERE shop_id = {id:String}`,
          { id: a.shopId },
        ),
      ).toEqual([{ n: '0' }]);
      expect(await shopRow(a.shopId)).toBeUndefined();
      expect(await productRow(pa)).toBeUndefined();
      // the shop is gone for the membership gate
      await t.app
        .get<typeof ShopModel>(getModelToken(ShopModel))
        .update({ status: 'DELETED' } as never, { where: { id: a.shopId } });
      t.clock.advance(20_000); // the membership gate trusts its cache for 15 s
      const stats = await t
        .as(a.owner)
        .get(`/api/shops/${a.shopId}/stats?days=7`);
      expect(stats.status).toBe(404);
      expect(stats.body.code).toBe('shop_not_found');
      expect(
        (await t.as(a.owner).get(`/api/shops/${a.shopId}/dashboard/today`))
          .status,
      ).toBe(404);
      // other shops unchanged
      expect(await t.board(t.week(), 'all')).toEqual(
        bBoardBefore.filter((e) => e.shopId !== a.shopId),
      );
      expect(
        (
          await t
            .as(b.owner)
            .get(`/api/shops/${b.shopId}/stats?days=7`)
            .expect(200)
        ).body,
      ).toEqual(bStatsBefore);
      expect(await shopRow(b.shopId)).toMatchObject({ name: 'Beta' });
      expect(await productRow(pb)).toMatchObject({ category: 'electronics' });

      // a repeat delivery changes nothing
      const snapshotBefore = await t.snapshotRows('2026-W40');
      const results = [
        await t.deliver(erasure, [deleted]),
        await t.deliver(names, [deleted]),
      ];
      expect(results.flatMap((r) => r.deadLettered)).toEqual([]);
      expect(await t.snapshotRows('2026-W40')).toEqual(snapshotBefore);
      expect(await t.board(t.week(), 'all')).toEqual(
        bBoardBefore.filter((e) => e.shopId !== a.shopId),
      );
    });
  });

  it('S40 AS-60: erasure is idempotent for a shop that was never known', async () => {
    const result = await t.deliver(t.projector(ShopErasureProjector), [
      t.shopDeleted(uuidv4()),
    ]);
    expect(result.deadLettered).toEqual([]);
  });
});
