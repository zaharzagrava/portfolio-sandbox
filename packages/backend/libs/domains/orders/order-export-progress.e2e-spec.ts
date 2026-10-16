import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { orderExportSchema } from '@marketplace-sandbox/contracts';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  DAY,
  MIN,
  T,
  createExportApp,
  seedBulkLines,
  seedF5,
  startExport,
  type ExportKit,
  type F5,
} from './testing/order-export.fixtures';
import { randomUUID } from 'node:crypto';

describe('Order export: progress, the live channel and the polled state', () => {
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
  /** Spies a spec installs; restored one by one (the kit's own spies must survive from test to test). */
  const spies: jest.SpyInstance[] = [];
  const spy = <S extends jest.SpyInstance>(s: S): S => {
    spies.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of spies.splice(0)) s.mockRestore();
    await kit.forget(shops.splice(0));
  });

  const f5 = async (): Promise<F5> => {
    const f = await seedF5(kit);
    shops.push(...f.shopIds);
    return f;
  };
  const started = async (f: F5) => {
    const res = await startExport(kit, f.U, f.S.id);
    expect(res.status).toBe(202);
    return res.body.exportId as string;
  };
  const poll = (f: F5, exportId: string) =>
    kit.as(f.U).get(`/api/shops/${f.S.id}/order-exports/${exportId}`);

  describe('progress events (AS-15)', () => {
    it('S12 AS-15: 25,000 lines with a clock ticking one second a batch publish 25 live progress events, then a replayable done; the stored counters follow the last event', async () => {
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      shops.push(shop.id);
      const product = await createProduct(kit.app, shop, {
        externalSku: 'SKU-PG',
      });
      await seedBulkLines(kit.app, {
        shopId: shop.id,
        productId: product.id,
        buyerId: owner.id,
        orders: 250,
        perOrder: 100,
        at: new Date(T.getTime() - DAY),
      });
      const exportId = (await startExport(kit, owner, shop.id)).body
        .exportId as string;
      // One second passes per batch; at the start of each batch the job already holds the last event's counters.
      const stored: Array<{ rows: number; lastEvent: number }> = [];
      kit.hooks.onLookup = async () => {
        kit.clock.advance(1_000);
        const events = kit.rt.of(exportId).filter((e) => e.type === 'progress');
        const job = await kit.jobs.findById(exportId);
        stored.push({
          rows: job!.rowsWritten,
          lastEvent: events.length
            ? (events.at(-1)!.data.rowsWritten as number)
            : 0,
        });
      };

      await kit.run.handle(exportId);

      const live = kit.rt.of(exportId);
      const progress = live.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(25);
      expect(progress.map((e) => e.data.rowsWritten)).toEqual(
        Array.from({ length: 25 }, (_, i) => (i + 1) * 1000),
      );
      const bytes = progress.map((e) => e.data.bytesWritten as number);
      expect(bytes.every((b, i) => i === 0 || b > bytes[i - 1])).toBe(true);
      expect(progress.every((e) => e.data.totalRows === 25_000)).toBe(true);
      expect(progress.every((e) => e.replay === false)).toBe(true);
      expect(stored.every((s) => s.rows === s.lastEvent)).toBe(true);
      const last = live.at(-1)!;
      expect(last.type).toBe('done');
      expect(last.replay).toBe(true);
      expect(last.data).toMatchObject({ rowsWritten: 25_000 });
      const job = await kit.jobs.findById(exportId);
      expect(job!.rowsWritten).toBe(25_000);
      expect(last.data.bytesWritten).toBe(job!.bytesWritten);
    });
  });

  describe('the live channel is advisory (AS-17)', () => {
    it('S12 AS-17: with a realtime backplane that fails every publish the export still ends DONE with a correct file, and the failure is logged once a minute at most', async () => {
      const f = await f5();
      const exportId = await started(f);
      kit.rt.down = true;
      const error = spy(jest.spyOn(Logger.prototype, 'error'));

      await kit.run.handle(exportId);

      const job = orderExportSchema.parse((await poll(f, exportId)).body);
      expect(job).toMatchObject({
        status: 'DONE',
        rowsWritten: 5,
        totalRows: 5,
      });
      expect(
        (await kit.fileOf(exportId)).split('\r\n').filter(Boolean),
      ).toHaveLength(6);
      // allow the fire-and-forget publishes to settle
      await new Promise((resolve) => setTimeout(resolve, 100));
      const logged = error.mock.calls.filter(([m]) =>
        String(m).startsWith('order_export_live_publish_failed'),
      );
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).not.toMatch(/SKU|Cable|\d{4}/);
      kit.clock.advance(61_000);
      kit.rt.down = true;
      const second = (await startExport(kit, f.U, f.S.id)).body
        .exportId as string;
      await kit.run.handle(second);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        error.mock.calls.filter(([m]) =>
          String(m).startsWith('order_export_live_publish_failed'),
        ),
      ).toHaveLength(2); // a minute later it may be logged again
    });
  });

  describe('who may listen (AS-18)', () => {
    it('S12 AS-18: members of the shop with orders.manage may follow order-export:E; everyone else is refused alike; there is no job: topic', async () => {
      const f = await f5();
      const exportId = await started(f);
      const topic = `order-export:${exportId}`;
      const registry = kit.app.get(TopicRegistry);

      expect(await registry.canSubscribe({ userId: f.U.id }, topic)).toBe(true);
      expect(await registry.canSubscribe({ userId: f.W.id }, topic)).toBe(true);
      for (const viewer of [
        { userId: f.V.id }, // member without orders.manage
        { userId: f.X.id }, // member of another shop
        { userId: f.N.id }, // member of nothing
        {}, // anonymous
        { userId: randomUUID() }, // unknown user
      ])
        expect(await registry.canSubscribe(viewer, topic)).toBe(false);
      expect(
        await registry.canSubscribe(
          { userId: f.U.id },
          `order-export:${randomUUID()}`,
        ),
      ).toBe(false); // an export that does not exist
      expect(
        await registry.canSubscribe({ userId: f.U.id }, `job:${exportId}`),
      ).toBe(false);

      // a member removed a moment ago
      const removed = await kit
        .as(f.U)
        .delete(`/api/shops/${f.S.id}/members/${f.W.id}`);
      expect(removed.status).toBeLessThan(300);
      expect(await registry.canSubscribe({ userId: f.W.id }, topic)).toBe(
        false,
      );

      // a subscriber arriving after the end is served the replayed terminal event
      await kit.run.handle(exportId);
      const terminal = kit.rt.of(exportId).at(-1)!;
      expect(terminal).toMatchObject({ type: 'done', replay: true });
    });
  });

  describe('the status is the truth (AS-19)', () => {
    it('S12 AS-19: a running export shows its counters and no expiry; the download is refused with export_not_ready before DONE and signs nothing', async () => {
      const f = await f5();
      const sign = spy(jest.spyOn(kit.app.get(ObjectStorage), 'presignGet'));
      const download = (id: string) =>
        kit.as(f.U).get(`/api/shops/${f.S.id}/order-exports/${id}/download`);

      // QUEUED
      const queued = await started(f);
      expect((await download(queued)).status).toBe(409);
      expect((await download(queued)).body.code).toBe('export_not_ready');

      // RUNNING at 3,000 of 10,000 rows (a worker that holds the lease and has stored its counters)
      const claimed = await kit.jobs.claim({
        exportId: queued,
        leaseHolder: randomUUID(),
        leaseExpiresAt: new Date(T.getTime() + 5 * MIN),
        now: T,
      });
      await kit.jobs.recordProgress(queued, claimed!.leaseHolder!, {
        rowsWritten: 3_000,
        bytesWritten: 120_000,
        totalRows: 10_000,
      });
      const running = await poll(f, queued);
      expect(running.status).toBe(200);
      expect(orderExportSchema.parse(running.body)).toMatchObject({
        status: 'RUNNING',
        rowsWritten: 3_000,
        totalRows: 10_000,
        expiresAt: null,
      });
      expect((await download(queued)).body.code).toBe('export_not_ready');

      // FAILED
      await kit.jobs.finish({
        exportId: queued,
        leaseHolder: claimed!.leaseHolder!,
        to: 'FAILED',
        failureCode: 'storage_unavailable',
        rowsWritten: 0,
        bytesWritten: 0,
        now: T,
      });
      expect((await download(queued)).status).toBe(409);

      // CANCELLED
      const second = await started(f);
      expect(
        (
          await kit
            .as(f.U)
            .post(`/api/shops/${f.S.id}/order-exports/${second}/cancel`)
        ).status,
      ).toBe(200);
      expect((await download(second)).status).toBe(409);
      expect((await download(second)).body.code).toBe('export_not_ready');

      expect(sign).not.toHaveBeenCalled();
    });
  });
});
