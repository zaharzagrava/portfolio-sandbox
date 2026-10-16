import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  DAY,
  MIN,
  T,
  createExportApp,
  csvRows,
  seedBulkLines,
  startExport,
  waitFor,
  type ExportKit,
} from './testing/order-export.fixtures';

describe('Order export: batches, no lost or repeated line, no held connection', () => {
  let kit: ExportKit;
  let db: Sequelize;
  const shops: string[] = [];

  beforeAll(async () => {
    kit = await createExportApp();
    db = kit.app.get(Sequelize);
  });
  afterAll(async () => {
    await kit.forget(shops);
    await kit.close();
  });
  beforeEach(async () => {
    await kit.reset();
  });
  afterEach(async () => {
    await kit.forget(shops.splice(0));
  });

  /** A shop with an owner and one product; returns what a spec needs to seed and start. */
  const seller = async () => {
    const owner = await kit.newUser();
    const shop = await createShop(kit.app, owner);
    shops.push(shop.id);
    const product = await createProduct(kit.app, shop, {
      externalSku: 'SKU-X',
    });
    return { owner, shop, product };
  };
  const exportOf = async (s: Awaited<ReturnType<typeof seller>>) => {
    const res = await startExport(kit, s.owner, s.shop.id);
    expect(res.status).toBe(202);
    return res.body.exportId as string;
  };
  const longAgo = new Date(T.getTime() - DAY);

  describe('batch boundaries (AS-09)', () => {
    it.each([
      ['0 lines', 0, 0],
      ['1 line', 1, 1],
      ['999 lines', 111, 9],
      ['exactly 1,000 lines', 100, 10],
      ['1,001 lines', 1001, 1],
      ['2,500 lines under one timestamp', 250, 10],
    ])(
      'S12 AS-09: %s: every line is written exactly once, in order, and rowsWritten equals totalRows',
      async (_label, orders, perOrder) => {
        const s = await seller();
        const seeded = orders
          ? await seedBulkLines(kit.app, {
              shopId: s.shop.id,
              productId: s.product.id,
              buyerId: s.owner.id,
              orders,
              perOrder,
              at: longAgo,
            })
          : 0;
        const exportId = await exportOf(s);

        await kit.run.handle(exportId);

        const job = await kit.jobs.findById(exportId);
        expect(job).toMatchObject({
          status: 'DONE',
          totalRows: seeded,
          rowsWritten: seeded,
        });
        const rows = csvRows(await kit.fileOf(exportId));
        expect(rows).toHaveLength(seeded);
        const titles = rows.map((r) => r.split(',')[7]);
        expect(new Set(titles).size).toBe(seeded); // none repeated
        expect(
          new Set(titles.map((t) => Number(t.replace('bulk-', '')))).size,
        ).toBe(seeded);
        // the order is (shop order time, shop order id): never backwards
        const keys = rows.map((r) => `${r.split(',')[2]}|${r.split(',')[1]}`);
        expect(keys.every((k, i) => i === 0 || keys[i - 1] <= k)).toBe(true);
      },
    );

    it('S12 AS-09: a shop order whose three lines straddle a batch boundary appears complete', async () => {
      const s = await seller();
      // 333 shop orders of 3 lines = 999 lines, then one shop order whose 3 lines are lines 1000, 1001 and 1002.
      await seedBulkLines(kit.app, {
        shopId: s.shop.id,
        productId: s.product.id,
        buyerId: s.owner.id,
        orders: 334,
        perOrder: 3,
        at: longAgo,
      });
      const exportId = await exportOf(s);

      await kit.run.handle(exportId);

      const rows = csvRows(await kit.fileOf(exportId));
      expect(rows).toHaveLength(1002);
      const perShopOrder = new Map<string, number>();
      for (const row of rows) {
        const id = row.split(',')[1];
        perShopOrder.set(id, (perShopOrder.get(id) ?? 0) + 1);
      }
      expect(perShopOrder.size).toBe(334);
      expect([...perShopOrder.values()].every((n) => n === 3)).toBe(true);
      // the file is contiguous per shop order (a shop order is never interleaved with another)
      const sequence = rows.map((r) => r.split(',')[1]);
      const seen = new Set<string>();
      let previous = '';
      for (const id of sequence) {
        if (id !== previous) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
          previous = id;
        }
      }
    });
  });

  describe('constant memory (AS-12)', () => {
    /** Heap growth over the run's start, sampled every 20 ms while the real pipeline runs. */
    const peakGrowthOf = async (lines: number) => {
      const s = await seller();
      await seedBulkLines(kit.app, {
        shopId: s.shop.id,
        productId: s.product.id,
        buyerId: s.owner.id,
        orders: lines / 10,
        perOrder: 10,
        at: longAgo,
      });
      const exportId = await exportOf(s);
      global.gc?.();
      const base = process.memoryUsage().heapUsed;
      let peak = base;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }, 20);
      try {
        await kit.run.handle(exportId);
      } finally {
        clearInterval(timer);
      }
      const job = await kit.jobs.findById(exportId);
      expect(job).toMatchObject({
        status: 'DONE',
        totalRows: lines,
        rowsWritten: lines,
      });
      return (peak - base) / (1024 * 1024);
    };

    it('S12 AS-12: heap stays under 200 MB and does not grow with the number of lines (scaled run; the 100k/1M measurement is scripts/bench/order-export-bench.ts)', async () => {
      const small = await peakGrowthOf(3_000);
      const large = await peakGrowthOf(30_000);
      expect(small).toBeLessThan(200);
      expect(large).toBeLessThan(200);
      // ten times the lines: flat, not proportional
      expect(large - small).toBeLessThan(60);
    }, 240_000);
  });

  describe('orders change during the run (AS-10)', () => {
    it('S12 AS-10: between batches the export holds no transaction or connection; a later order is not in the file and a status change shows as of its batch', async () => {
      const s = await seller();
      await seedBulkLines(kit.app, {
        shopId: s.shop.id,
        productId: s.product.id,
        buyerId: s.owner.id,
        orders: 300,
        perOrder: 10,
        at: new Date(T.getTime() - 2 * DAY),
      });
      const exportId = await exportOf(s);
      kit.storageControl.hold();
      kit.resetLinesRead();

      const running = kit.run.handle(exportId);
      await waitFor('the first batch was read', () => kit.linesRead() >= 1000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(kit.linesRead()).toBe(1000); // paused: the storage side takes nothing

      // The export holds nothing while it waits for the storage side.
      const open = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
        { type: QueryTypes.SELECT },
      );
      expect(Number(open[0].n)).toBe(0);

      // A new order after the request, and a status change on the first and the last shop order.
      const first = await db.query<{ id: string }>(
        `SELECT "id" FROM "ShopOrder" WHERE "shopId" = :shopId ORDER BY "createdAt", "id" LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { shopId: s.shop.id } },
      );
      const last = await db.query<{ id: string }>(
        `SELECT "id" FROM "ShopOrder" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { shopId: s.shop.id } },
      );
      await db.query(
        `UPDATE "ShopOrder" SET "status" = 'REFUNDED' WHERE "id" IN (:ids)`,
        {
          replacements: { ids: [first[0].id, last[0].id] },
        },
      );
      await seedBulkLines(kit.app, {
        shopId: s.shop.id,
        productId: s.product.id,
        buyerId: s.owner.id,
        orders: 1,
        perOrder: 5,
        at: new Date(T.getTime() + MIN),
      });

      kit.storageControl.release();
      await running;

      const job = await kit.jobs.findById(exportId);
      expect(job).toMatchObject({
        status: 'DONE',
        totalRows: 3000,
        rowsWritten: 3000,
      });
      const rows = csvRows(await kit.fileOf(exportId));
      expect(rows).toHaveLength(3000); // the later order is not in the file
      const statusOf = (shopOrderId: string) =>
        rows
          .filter((r) => r.split(',')[1] === shopOrderId)
          .map((r) => r.split(',')[3]);
      // already read at its batch: the earlier status; read later: the status it had then
      expect(statusOf(first[0].id).every((x) => x === 'PAID')).toBe(true);
      expect(statusOf(last[0].id).every((x) => x === 'REFUNDED')).toBe(true);
      expect(new Set(rows.map((r) => r.split(',')[7])).size).toBe(3000);
    });
  });
});
