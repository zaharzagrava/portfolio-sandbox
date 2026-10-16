import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import {
  orderExportDownloadSchema,
  orderExportPageSchema,
  orderExportSchema,
} from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { createProducts } from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  CSV_BOM,
  DAY,
  HEADER,
  MIN,
  T,
  createExportApp,
  outboxRowsFor,
  seedF5,
  seedOrder,
  startExport,
  type ExportKit,
  type F5,
} from './testing/order-export.fixtures';

describe('Order export: start, run, file and download', () => {
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

  const f5 = async (): Promise<F5> => {
    const f = await seedF5(kit);
    shops.push(...f.shopIds);
    return f;
  };
  const history = (exportId: string) =>
    db.query<{
      fromStatus: string | null;
      toStatus: string;
      actor: string | null;
      at: Date;
      reason: string | null;
    }>(
      `SELECT "fromStatus", "toStatus", "actor", "at", "reason" FROM "ExportJobHistory" WHERE "exportId" = :exportId ORDER BY "at", "id"`,
      { type: QueryTypes.SELECT, replacements: { exportId } },
    );
  const records = (file: string) =>
    file
      .slice(CSV_BOM.length)
      .split('\r\n')
      .filter((line) => line.length > 0);
  const jobCount = async (shopId: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "ExportJob" WHERE "shopId" = :shopId`,
          { type: QueryTypes.SELECT, replacements: { shopId } },
        )
      )[0].n,
    );
  const started = async (f: F5, user = f.U) => {
    const res = await startExport(kit, user, f.S.id);
    expect(res.status).toBe(202);
    return res.body.exportId as string;
  };

  describe('start (AS-01)', () => {
    it('S12 AS-01: starting answers 202 with Location and the queued job, writes one job, one history row and one message on order-exports', async () => {
      const f = await f5();
      const res = await startExport(kit, f.U, f.S.id, 'k-0001-abcd');

      expect(res.status).toBe(202);
      const body = orderExportSchema.parse(res.body);
      expect(res.headers.location).toBe(
        `/api/shops/${f.S.id}/order-exports/${body.exportId}`,
      );
      expect(body).toEqual({
        exportId: body.exportId,
        status: 'QUEUED',
        rowsWritten: 0,
        totalRows: null,
        bytesWritten: 0,
        attempt: 0,
        failure: null,
        createdBy: f.U.id,
        createdAt: T.toISOString(),
        startedAt: null,
        finishedAt: null,
        expiresAt: null,
      });

      const jobs = await db.query<{
        shopId: string;
        createdBy: string;
        status: string;
      }>(
        `SELECT "shopId", "createdBy", "status" FROM "ExportJob" WHERE "shopId" = :shopId`,
        { type: QueryTypes.SELECT, replacements: { shopId: f.S.id } },
      );
      expect(jobs).toEqual([
        { shopId: f.S.id, createdBy: f.U.id, status: 'QUEUED' },
      ]);
      const rows = await history(body.exportId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'QUEUED',
        actor: f.U.id,
      });
      expect(new Date(rows[0].at)).toEqual(T);
      expect(kit.enqueued.filter((m) => m.queue === 'order-exports')).toEqual([
        {
          queue: 'order-exports',
          body: { exportId: body.exportId },
          options: undefined,
        },
      ]);
      expect(kit.enqueued.filter((m) => m.queue === 'catalog-imports')).toEqual(
        [],
      );
      expect(
        await kit.app.get(ObjectStorage).list(`exports/${f.S.id}/`),
      ).toEqual([]);
      expect(await outboxRowsFor(db, body.exportId)).toEqual([]);
    });
  });

  describe('run and file (AS-02, AS-03, AS-04)', () => {
    it("S12 AS-02: the worker takes the queued export to DONE with the shop's five lines, history, one event and live progress then done", async () => {
      const f = await f5();
      const exportId = await started(f);

      expect(await kit.run.handle(exportId)).toBe('done');

      const res = await kit
        .as(f.U)
        .get(`/api/shops/${f.S.id}/order-exports/${exportId}`);
      expect(res.status).toBe(200);
      const job = orderExportSchema.parse(res.body);
      const stored = await kit.jobs.findById(exportId);
      const head = await kit.app.get(ObjectStorage).head(stored!.fileKey!);
      expect(job).toMatchObject({
        status: 'DONE',
        attempt: 1,
        totalRows: 5,
        rowsWritten: 5,
        bytesWritten: head!.size,
        startedAt: T.toISOString(),
        finishedAt: T.toISOString(),
        expiresAt: new Date(T.getTime() + 7 * DAY).toISOString(),
        failure: null,
      });
      const files = await kit.app
        .get(ObjectStorage)
        .list(`exports/${f.S.id}/${exportId}/`);
      expect(files).toHaveLength(1);

      const file = await kit.fileOf(exportId);
      expect(records(file)).toHaveLength(1 + 5);
      expect(file).not.toContain(f.P3);
      expect(file).not.toContain('Other');

      expect((await history(exportId)).map((h) => h.toStatus)).toEqual([
        'QUEUED',
        'RUNNING',
        'DONE',
      ]);
      const outbox = await outboxRowsFor(db, exportId);
      expect(
        outbox.filter((o) => o.type === 'orderexport.finished'),
      ).toHaveLength(1);

      const live = kit.rt.of(exportId);
      const types = live.map((e) => e.type);
      expect(types.at(-1)).toBe('done');
      expect(types.slice(0, -1).every((t) => t === 'progress')).toBe(true);
      expect(types.length).toBeGreaterThanOrEqual(2);
      expect(live.at(-1)!.data).toEqual({
        rowsWritten: 5,
        bytesWritten: head!.size,
      });
    });

    it('S12 AS-03: the file has the BOM, the exact header, quoted cells, the 9,007,199,254,740,993 amount digit for digit and no personal data', async () => {
      const f = await f5();
      await seedOrder(kit.app, {
        buyerId: f.U.id,
        createdAt: new Date(T.getTime() - 12 * 60 * MIN),
        slices: [
          {
            shopId: f.S.id,
            status: 'PAID',
            lines: [
              {
                productId: f.P1,
                title: 'Big ticket',
                quantity: 1,
                unitPriceMinor: '9007199254740993',
                lineTotalMinor: '9007199254740993',
              },
            ],
          },
        ],
      });
      const exportId = await started(f);
      await kit.run.handle(exportId);

      const file = await kit.fileOf(exportId);
      expect(file.startsWith(CSV_BOM)).toBe(true);
      const lines = records(file);
      expect(lines[0]).toBe(HEADER);
      const at = (days: number) =>
        new Date(T.getTime() - days * DAY).toISOString();
      expect(lines.slice(1)).toEqual([
        `${f.O1},${f.SO1},${at(3)},PAID,EUR,${f.P1},SKU-P1,"Cable, braided",2,1000,100,1900`,
        `${f.O1},${f.SO1},${at(3)},PAID,EUR,${f.P2},SKU-P2,"He said ""hi""",1,500,0,500`,
        `${f.O2},${f.SO2},${at(2)},REFUNDED,EUR,${f.P1},SKU-P1,"Cable, braided",1,1000,0,1000`,
        `${f.O3},${f.SO3},${at(1)},CANCELLED,EUR,${f.P2},SKU-P2,"He said ""hi""",3,500,0,1500`,
        `${f.O3},${f.SO3},${at(1)},CANCELLED,EUR,${f.P1},SKU-P1,"Cable, braided",1,1000,0,1000`,
        expect.stringMatching(
          /^[0-9a-f-]{36},[0-9a-f-]{36},\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,PAID,EUR,[0-9a-f-]{36},SKU-P1,Big ticket,1,9007199254740993,0,9007199254740993$/,
        ),
      ]);
      expect(file).not.toContain(f.U.email);
      expect(file).not.toContain(f.U.id);
    });

    it('S12 AS-04: a shop with no orders ends DONE with a file of only the BOM and the header', async () => {
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      shops.push(shop.id);
      const res = await startExport(kit, owner, shop.id);
      const exportId = res.body.exportId as string;

      await kit.run.handle(exportId);

      const job = await kit.jobs.findById(exportId);
      expect(job).toMatchObject({
        status: 'DONE',
        totalRows: 0,
        rowsWritten: 0,
      });
      const file = await kit.fileOf(exportId);
      expect(file).toBe(CSV_BOM + HEADER + '\r\n');
      expect(job!.bytesWritten).toBe(Buffer.byteLength(file));
      const done = kit.rt.of(exportId).at(-1)!;
      expect(done).toMatchObject({
        type: 'done',
        data: { rowsWritten: 0, bytesWritten: Buffer.byteLength(file) },
      });
    });
  });

  describe('download and determinism (AS-05, AS-06)', () => {
    it('S12 AS-05: the download is a ten-minute attachment link to the exact bytes and the audit line omits the link', async () => {
      const f = await f5();
      const exportId = await started(f);
      await kit.run.handle(exportId);
      const log = jest.spyOn(Logger.prototype, 'log');

      const res = await kit
        .as(f.U)
        .get(`/api/shops/${f.S.id}/order-exports/${exportId}/download`);

      expect(res.status).toBe(200);
      const body = orderExportDownloadSchema.parse(res.body);
      expect(body.expiresAt).toBe(
        new Date(T.getTime() + 10 * MIN).toISOString(),
      );
      const url = new URL(body.url);
      expect(url.searchParams.get('response-content-disposition')).toBe(
        `attachment; filename="orders-${exportId}.csv"`,
      );
      expect(url.searchParams.get('response-content-type')).toBe('text/csv');
      const fetched = await fetch(body.url);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer()).toString('utf8')).toBe(
        await kit.fileOf(exportId),
      );

      const audit = log.mock.calls
        .map(([message]) => message)
        .filter(
          (m): m is Record<string, unknown> =>
            typeof m === 'object' &&
            m !== null &&
            (m as { event?: string }).event === 'order_export_downloaded',
        );
      log.mockRestore();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        exportId,
        shopId: f.S.id,
        userId: f.U.id,
      });
      expect(JSON.stringify(audit[0])).not.toContain(body.url);
    });

    it('S12 AS-06: two exports of unchanged orders are byte-identical, ordered by shop order time, shop order id and line id', async () => {
      const f = await f5();
      const first = await started(f);
      await kit.run.handle(first);
      const second = await started(f);
      await kit.run.handle(second);

      const a = await kit.fileOf(first);
      const b = await kit.fileOf(second);
      expect(b).toBe(a);
      expect(records(a)).toHaveLength(6);
      const times = records(a)
        .slice(1)
        .map((line) => line.split(',')[2]);
      expect([...times].sort()).toEqual(times);
    });
  });

  describe("SKU, title and only the shop's lines (AS-07, AS-08)", () => {
    it('S12 AS-07: a batch of 1,000 lines over 700 products asks the catalog twice (500 and 200 ids, shop-scoped); deleted products have an empty SKU and titles are the purchase snapshot', async () => {
      const f = await f5();
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      shops.push(shop.id);
      const products = await createProducts(kit.app, shop, 700, {
        externalSku: undefined,
      });
      // SKU per product, a renamed P1 and a deleted P9 (the last product).
      await db.query(
        `UPDATE "Product" SET "externalSku" = 'SKU-' || "id"::text WHERE "shopId" = :shopId`,
        { replacements: { shopId: shop.id } },
      );
      const renamed = products[0];
      const deleted = products[699];
      await db.query(
        `UPDATE "Product" SET "title" = 'Renamed in catalog' WHERE "id" = :id`,
        {
          replacements: { id: renamed.id },
        },
      );
      await db.query(`DELETE FROM "Product" WHERE "id" = :id`, {
        replacements: { id: deleted.id },
      });
      const orderId = uuidv7();
      const shopOrderId = uuidv7();
      const at = new Date(T.getTime() - DAY);
      await db.query(
        `INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash", "version", "createdAt", "updatedAt")
         VALUES (:orderId, :buyer, 'PAID', 0, 'EUR', :key, 'seed', 1, :at, :at)`,
        {
          replacements: { orderId, buyer: f.U.id, key: `seed-${orderId}`, at },
        },
      );
      await db.query(
        `INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
         VALUES (:shopOrderId, :orderId, :shopId, 0, 'PAID', :at, :at)`,
        { replacements: { shopOrderId, orderId, shopId: shop.id, at } },
      );
      const ids = products.map((p) => p.id);
      await db.query(
        `INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
         SELECT uuidv7(), :orderId, (ARRAY[:ids]::uuid[])[1 + (n % 700)], 'Snapshot ' || (n % 700), 1, 100, 0, 100, :shopId, :at, :at
           FROM generate_series(0, 999) AS n`,
        { replacements: { orderId, ids, shopId: shop.id, at } },
      );
      const res = await startExport(kit, owner, shop.id);
      const exportId = res.body.exportId as string;

      kit.skuCalls.length = 0;
      await kit.run.handle(exportId);

      expect(kit.skuCalls).toEqual([
        { ids: 500, options: { shopId: shop.id } },
        { ids: 200, options: { shopId: shop.id } },
      ]);
      const lines = records(await kit.fileOf(exportId)).slice(1);
      expect(lines).toHaveLength(1000);
      const ofProduct = (id: string) =>
        lines.filter((l) => l.split(',')[5] === id);
      expect(ofProduct(deleted.id).length).toBeGreaterThan(0);
      for (const line of ofProduct(deleted.id))
        expect(line.split(',')[6]).toBe(''); // empty SKU, line still exported
      const renamedLine = ofProduct(renamed.id)[0].split(',');
      expect(renamedLine[6]).toMatch(/^SKU-/);
      expect(renamedLine[7]).toBe('Snapshot 0'); // the title taken at purchase
      expect(lines.join('\n')).not.toContain('Renamed in catalog');
    });

    it("S12 AS-08: each shop exports only its own lines; a line without a shop is in neither file; a shared order contributes each shop's own slice", async () => {
      const f = await f5();
      await seedOrder(kit.app, {
        buyerId: f.U.id,
        createdAt: new Date(T.getTime() - 6 * 60 * MIN),
        slices: [
          {
            shopId: null,
            status: 'PAID',
            lines: [
              {
                productId: f.P1,
                title: 'Legacy line',
                quantity: 1,
                unitPriceMinor: 100,
                lineTotalMinor: 100,
              },
            ],
          },
        ],
      });
      const a = await started(f);
      const b = (await startExport(kit, f.X, f.S2.id)).body.exportId as string;

      await kit.run.handle(a);
      await kit.run.handle(b);

      const fileS = await kit.fileOf(a);
      const fileS2 = await kit.fileOf(b);
      expect(records(fileS)).toHaveLength(1 + 5);
      expect(records(fileS2)).toHaveLength(1 + 1);
      expect(fileS2).toContain(`${f.O2},${f.SO2b}`);
      expect(fileS).not.toContain(f.SO2b);
      expect(fileS).not.toContain('Legacy line');
      expect(fileS2).not.toContain('Legacy line');
    });
  });

  describe('idempotent, single, rate-limited start (AS-20 to AS-26)', () => {
    const startsFor = (shopId: string) =>
      kit.enqueued.filter((m) => m.queue === 'order-exports').length;

    it('S12 AS-20: a replay with the same key answers the stored body and Location with Idempotency-Replayed and creates nothing', async () => {
      const f = await f5();
      const first = await startExport(kit, f.U, f.S.id, 'k-replay-0001');
      expect(first.status).toBe(202);

      const second = await startExport(kit, f.U, f.S.id, 'k-replay-0001');

      expect(second.status).toBe(202);
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(second.headers.location).toBe(first.headers.location);
      expect(second.text).toBe(first.text);
      expect(await jobCount(f.S.id)).toBe(1);
      expect(await history(first.body.exportId)).toHaveLength(1);
      expect(startsFor(f.S.id)).toBe(1);
    });

    it('S12 AS-21: two identical requests at the same instant give one 202 and one 409 idempotency_in_flight with Retry-After 1; a third replays', async () => {
      const f = await f5();
      kit.hooks.onEnqueue = () =>
        new Promise((resolve) => setTimeout(resolve, 400));

      const [a, b] = await Promise.all([
        startExport(kit, f.U, f.S.id, 'k-flight-0001'),
        startExport(kit, f.U, f.S.id, 'k-flight-0001'),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([202, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body.code).toBe('idempotency_in_flight');
      expect(refused.headers['retry-after']).toBe('1');
      expect(await jobCount(f.S.id)).toBe(1);
      const third = await startExport(kit, f.U, f.S.id, 'k-flight-0001');
      expect(third.status).toBe(202);
      expect(third.headers['idempotency-replayed']).toBe('true');
    });

    it("S12 AS-22: the key of one shop on another shop's path is a key reuse and creates no export", async () => {
      const f = await f5();
      const other = await createShop(kit.app, f.U);
      shops.push(other.id);
      expect((await startExport(kit, f.U, f.S.id, 'k-reuse-0001')).status).toBe(
        202,
      );

      const res = await startExport(kit, f.U, other.id, 'k-reuse-0001');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
      expect(await jobCount(other.id)).toBe(0);
    });

    it('S12 AS-23: a missing key is idempotency_key_required and a key of 7, 129 characters or with a space is idempotency_key_invalid; no export is created', async () => {
      const f = await f5();
      const missing = await kit
        .as(f.U)
        .post(`/api/shops/${f.S.id}/order-exports`)
        .send({});
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      for (const key of ['abcdefg', 'a'.repeat(129), 'has space 1234']) {
        const res = await startExport(kit, f.U, f.S.id, key);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('idempotency_key_invalid');
      }
      expect(await jobCount(f.S.id)).toBe(0);
    });

    it("S12 AS-24: U and W starting at the same instant make one export; the loser gets 409 export_already_active with the winner's id; the other shop is unaffected", async () => {
      const f = await f5();
      kit.hooks.onEnqueue = () =>
        new Promise((resolve) => setTimeout(resolve, 200));

      const [a, b] = await Promise.all([
        startExport(kit, f.U, f.S.id, 'k-active-u001'),
        startExport(kit, f.W, f.S.id, 'k-active-w001'),
      ]);

      expect([a.status, b.status].sort()).toEqual([202, 409]);
      const winner = a.status === 202 ? a : b;
      const loser = a.status === 202 ? b : a;
      expect(loser.body.code).toBe('export_already_active');
      expect(loser.body.activeExportId).toBe(winner.body.exportId);
      expect(await jobCount(f.S.id)).toBe(1);
      expect(startsFor(f.S.id)).toBe(1);
      const third = await startExport(kit, f.U, f.S.id, 'k-active-u002');
      expect(third.status).toBe(409);
      expect(third.body.activeExportId).toBe(winner.body.exportId);
      expect((await startExport(kit, f.X, f.S2.id)).status).toBe(202);
    });

    it.each(['DONE', 'FAILED', 'CANCELLED'] as const)(
      'S12 AS-25: after the earlier export is %s the key a refusal used creates a new export',
      async (finalStatus) => {
        const f = await f5();
        const winner = (await startExport(kit, f.U, f.S.id, 'k-first-0001'))
          .body.exportId as string;
        const refused = await startExport(kit, f.W, f.S.id, 'k-second-0002');
        expect(refused.status).toBe(409);

        if (finalStatus === 'DONE') await kit.run.handle(winner);
        else if (finalStatus === 'CANCELLED')
          await kit
            .as(f.U)
            .post(`/api/shops/${f.S.id}/order-exports/${winner}/cancel`);
        else {
          const claimed = await kit.jobs.claim({
            exportId: winner,
            leaseHolder: '00000000-0000-4000-8000-000000000001',
            leaseExpiresAt: new Date(T.getTime() + 5 * MIN),
            now: T,
          });
          await kit.jobs.finish({
            exportId: winner,
            leaseHolder: claimed!.leaseHolder!,
            to: 'FAILED',
            failureCode: 'storage_unavailable',
            rowsWritten: 0,
            bytesWritten: 0,
            now: T,
          });
        }

        const again = await startExport(kit, f.W, f.S.id, 'k-second-0002');
        expect(again.status).toBe(202);
        expect(again.body.exportId).not.toBe(winner);
        expect(await jobCount(f.S.id)).toBe(2);
      },
    );

    // (AS-26 follows; access, validation and listing are in the next describe)
    it('S12 AS-26: a sixth start within an hour is 429 rate_limited with Retry-After and creates nothing; with the limiter store down the start is refused and creates nothing', async () => {
      const f = await f5();
      for (let i = 0; i < 5; i++) {
        const res = await startExport(kit, f.U, f.S.id);
        expect(res.status).toBe(202);
        expect(
          (
            await kit
              .as(f.U)
              .post(
                `/api/shops/${f.S.id}/order-exports/${res.body.exportId}/cancel`,
              )
          ).status,
        ).toBe(200);
      }

      const sixth = await startExport(kit, f.U, f.S.id);

      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('rate_limited');
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number.isInteger(Number(sixth.headers['retry-after']))).toBe(true);
      expect(await jobCount(f.S.id)).toBe(5);

      // The limiter store is unreachable (an ACL that hides the limiter's keys): fail closed.
      const other = await createShop(kit.app, f.U);
      shops.push(other.id);
      const redis = kit.app.get(RedisService).client;
      await redis.call(
        'ACL',
        'SETUSER',
        'default',
        'resetkeys',
        '~[^r]*',
        '~r[^l]*',
        '~rl[^:]*',
      );
      try {
        const refused = await startExport(kit, f.U, other.id);
        expect([refused.status, refused.body.code]).toEqual([
          503,
          'rate_limiter_unavailable',
        ]);
        expect(await jobCount(other.id)).toBe(0);
      } finally {
        await redis.call('ACL', 'SETUSER', 'default', 'allkeys');
      }
    });
  });

  describe('access, shop gate, validation and list (AS-27 to AS-32)', () => {
    const base = (shopId: string) => `/api/shops/${shopId}/order-exports`;
    /** The five routes with their method; `id` fills the export segment. */
    const routes = (shopId: string, id: string) =>
      [
        ['post', base(shopId)],
        ['get', base(shopId)],
        ['get', `${base(shopId)}/${id}`],
        ['post', `${base(shopId)}/${id}/cancel`],
        ['get', `${base(shopId)}/${id}/download`],
      ] as const;
    const call = (
      user: { bearer: string } | null,
      method: 'get' | 'post',
      url: string,
    ) => {
      const req = kit.http()[method](url);
      if (user) req.set('Authorization', user.bearer);
      return method === 'post'
        ? req.set('Idempotency-Key', `key-${randomUUID()}`).send({})
        : req;
    };
    const problem = (res: {
      status: number;
      body: Record<string, unknown>;
    }) => ({
      status: res.status,
      code: res.body.code,
      title: res.body.title,
      detail: res.body.detail,
    });
    /** A finished export of `shopId` made without the queue (insert), `n` of them with the given times. */
    const insertExports = async (
      shopId: string,
      createdBy: string,
      rows: Array<{ status: 'DONE' | 'FAILED'; at: Date; id?: string }>,
    ) => {
      for (const r of rows)
        await db.query(
          `INSERT INTO "ExportJob" ("id", "shopId", "createdBy", "status", "createdAt", "updatedAt", "finishedAt")
           VALUES (:id, :shopId, :createdBy, :status, :at, :at, :at)`,
          {
            replacements: {
              id: r.id ?? uuidv7(),
              shopId,
              createdBy,
              status: r.status,
              at: r.at,
            },
          },
        );
    };

    it("S12 AS-27: anonymous is 401, a stranger and a member of another shop get the same 404 shop_not_found, a viewer gets 403 permission_denied; nothing changes; another shop's export is export_not_found like an unknown id", async () => {
      const f = await f5();
      const exportId = await started(f);
      const before = await kit.jobs.findById(exportId);

      for (const [method, url] of routes(f.S.id, exportId)) {
        expect((await call(null, method, url)).status).toBe(401);
        const stranger = problem(await call(f.N, method, url));
        expect(stranger).toMatchObject({ status: 404, code: 'shop_not_found' });
        expect(problem(await call(f.X, method, url))).toEqual(stranger);
        expect(problem(await call(f.V, method, url))).toMatchObject({
          status: 403,
          code: 'permission_denied',
        });
      }
      expect(await kit.jobs.findById(exportId)).toEqual(before);
      expect(await jobCount(f.S.id)).toBe(1);

      // X is a member of S2 and asks S2's routes for S's export, and for an id that does not exist.
      const unknown = randomUUID();
      for (const suffix of ['', '/cancel', '/download']) {
        const method = suffix === '/cancel' ? 'post' : 'get';
        const foreign = problem(
          await call(f.X, method, `${base(f.S2.id)}/${exportId}${suffix}`),
        );
        const missing = problem(
          await call(f.X, method, `${base(f.S2.id)}/${unknown}${suffix}`),
        );
        expect(foreign).toMatchObject({
          status: 404,
          code: 'export_not_found',
        });
        expect(foreign).toEqual(missing);
      }
      expect(await kit.jobs.findById(exportId)).toEqual(before);
    });

    it('S12 AS-28: a staff member with orders.manage lists, reads, downloads and cancels what the owner started; once removed the same calls are 404 shop_not_found', async () => {
      const f = await f5();
      const done = await started(f);
      await kit.run.handle(done);
      const second = await started(f);

      const list = await call(f.W, 'get', base(f.S.id));
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(2);
      expect((await call(f.W, 'get', `${base(f.S.id)}/${done}`)).status).toBe(
        200,
      );
      expect(
        (await call(f.W, 'get', `${base(f.S.id)}/${done}/download`)).status,
      ).toBe(200);
      expect(
        (await call(f.W, 'post', `${base(f.S.id)}/${second}/cancel`)).status,
      ).toBe(200);

      expect(
        (await kit.as(f.U).delete(`/api/shops/${f.S.id}/members/${f.W.id}`))
          .status,
      ).toBeLessThan(300);
      for (const [method, url] of routes(f.S.id, done)) {
        const res = await call(f.W, method, url);
        expect(problem(res)).toMatchObject({
          status: 404,
          code: 'shop_not_found',
        });
      }
    });

    it.each([
      ['SUSPENDED', 403, 'shop_suspended'],
      ['DELETING', 409, 'shop_offboarding'],
      ['DELETED', 404, 'shop_not_found'],
    ] as const)(
      'S12 AS-29: in a %s shop every export route answers %s %s, and a member without the permission gets permission_denied first',
      async (status, httpStatus, code) => {
        const owner = await kit.newUser();
        const viewer = await kit.newUser();
        const shop = await createShop(kit.app, owner, { status });
        shops.push(shop.id);
        await addMember(kit.app, shop.id, viewer.id, 'VIEWER');
        const id = randomUUID();

        for (const [method, url] of routes(shop.id, id)) {
          const res = await call(owner, method, url);
          expect(problem(res)).toMatchObject({ status: httpStatus, code });
          if (status !== 'DELETED')
            expect(problem(await call(viewer, method, url))).toMatchObject({
              status: 403,
              code: 'permission_denied',
            });
        }
        expect(await jobCount(shop.id)).toBe(0);
      },
    );

    it('S12 AS-30: malformed ids, a body that is not {}, bad list parameters and a garbage cursor are 400 and change nothing', async () => {
      const f = await f5();
      const exportId = await started(f);
      const bad = async (
        method: 'get' | 'post',
        url: string,
        body?: unknown,
        expected = 'validation_failed',
      ) => {
        const req = kit.as(f.U)[method](url);
        const res = await (method === 'post'
          ? req
              .set('Idempotency-Key', `key-${randomUUID()}`)
              .send(body as object)
          : req);
        expect([res.status, res.body.code]).toEqual([400, expected]);
      };

      await bad('get', `${base(f.S.id)}/not-a-uuid`);
      await bad('post', `${base(f.S.id)}/not-a-uuid/cancel`, {});
      await bad('get', `${base(f.S.id)}/${exportId}x/download`);
      // A malformed shop id never reaches the validation pipe: the shop guard (S03) answers it like an unknown shop.
      const malformedShop = await kit
        .as(f.U)
        .get('/api/shops/not-a-uuid/order-exports');
      expect([malformedShop.status, malformedShop.body.code]).toEqual([
        404,
        'shop_not_found',
      ]);
      await bad('post', base(f.S.id), { unknown: 1 });
      await bad('post', base(f.S.id), []);
      await bad('post', base(f.S.id), 'text');
      for (const limit of ['0', '101', 'abc'])
        await bad('get', `${base(f.S.id)}?limit=${limit}`);
      await bad('get', `${base(f.S.id)}?status=SLEEPING`);
      await bad(
        'get',
        `${base(f.S.id)}?cursor=garbage`,
        undefined,
        'invalid_cursor',
      );
      expect(await jobCount(f.S.id)).toBe(1);
    });

    it('S12 AS-31: 45 exports with tied times page 20, 20, 5 by time then id without a gap or repeat; the status filter and the shop filter hold', async () => {
      const f = await f5();
      const mine: string[] = [];
      const rows: Array<{ status: 'DONE' | 'FAILED'; at: Date; id: string }> =
        [];
      for (let i = 0; i < 45; i++) {
        const id = uuidv7();
        mine.push(id);
        rows.push({
          id,
          status: i % 3 === 0 ? 'FAILED' : 'DONE', // 15 FAILED, 30 DONE
          at: new Date(T.getTime() - Math.floor(i / 5) * MIN), // groups of 5 share one instant
        });
      }
      await insertExports(f.S.id, f.U.id, rows);
      await insertExports(f.S2.id, f.X.id, [
        { status: 'DONE', at: T },
        { status: 'DONE', at: T },
        { status: 'FAILED', at: T },
      ]);

      const walk = async (query: string) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        const pages: number[] = [];
        do {
          const res: { status: number; body: Record<string, unknown> } =
            await call(
              f.U,
              'get',
              `${base(f.S.id)}?limit=20${query}${cursor ? `&cursor=${cursor}` : ''}`,
            );
          expect(res.status).toBe(200);
          const page = orderExportPageSchema.parse(res.body);
          pages.push(page.items.length);
          seen.push(...page.items.map((i) => i.exportId));
          cursor = page.nextCursor;
        } while (cursor);
        return { seen, pages };
      };
      const all = await walk('');
      expect(all.pages).toEqual([20, 20, 5]);
      expect(new Set(all.seen).size).toBe(45);
      expect([...all.seen].sort()).toEqual([...mine].sort());
      const stored = await db.query<{ id: string }>(
        `SELECT "id" FROM "ExportJob" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC, "id" DESC`,
        { type: QueryTypes.SELECT, replacements: { shopId: f.S.id } },
      );
      expect(all.seen).toEqual(stored.map((r) => r.id));
      const done = await walk('&status=DONE');
      expect(done.seen).toHaveLength(30);
      expect(done.pages).toEqual([20, 10]);
    });

    it('S12 AS-32: a failed export shows its code and generic message and nothing internal', async () => {
      const f = await f5();
      const exportId = await started(f);
      const claimed = await kit.jobs.claim({
        exportId,
        leaseHolder: randomUUID(),
        leaseExpiresAt: new Date(T.getTime() + 5 * MIN),
        now: T,
      });
      await kit.jobs.finish({
        exportId,
        leaseHolder: claimed!.leaseHolder!,
        to: 'FAILED',
        failureCode: 'storage_unavailable',
        rowsWritten: 0,
        bytesWritten: 0,
        now: T,
      });

      const res = await call(f.U, 'get', `${base(f.S.id)}/${exportId}`);

      expect(res.status).toBe(200);
      const job = orderExportSchema.parse(res.body); // strict: no extra property
      expect(job.failure).toEqual({
        code: 'storage_unavailable',
        message: 'The file could not be stored. Start a new export.',
      });
      const text = JSON.stringify(res.body);
      for (const secret of [
        f.S.id,
        'exports/',
        'fileKey',
        'leaseHolder',
        'attempt-',
      ])
        expect(text).not.toContain(secret);
    });
  });
});
