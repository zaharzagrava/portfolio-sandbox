import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { trace, type Tracer } from '@opentelemetry/api';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  eventEnvelopeSchema,
  orderExportEventSchemas,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { CatalogImportModule } from '@app/domains/catalog-sync';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import { ordersExportRule } from '@app/common/config/orders-config';
import {
  OrderExportOffboardingConsumer,
  OrderExportShopDeletedConsumer,
} from './infra/order-export.tenancy.consumers';
import { OrderExportJobs } from './infra/order-export.jobs';
import {
  DAY,
  MIN,
  T,
  createExportApp,
  outboxRowsFor,
  seedBulkLines,
  seedF5,
  startExport,
  type ExportKit,
  type F5,
} from './testing/order-export.fixtures';

describe('Order export: retention, shop events, cutover, observability and configuration', () => {
  let kit: ExportKit;
  /** The structured-logger app of AS-58 and the catalog-sync-only app of AS-56. */
  let logged: ExportKit;
  let legacy: CatalogTestApp;
  let db: Sequelize;
  const shops: string[] = [];
  const written: string[] = [];
  let stdout: jest.SpyInstance;

  // The models belong to the app created last (they are bound to its connection) and so does the global logger: the
  // structured-logger app is created last and closed last; the others are closed before it.
  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    legacy = await createCatalogApp({ extraImports: [CatalogImportModule] });
    kit = await createExportApp();
    db = kit.app.get(Sequelize);
    logged = await createExportApp({ structuredLogger: true });
  });
  afterAll(async () => {
    await kit.forget(shops);
    await legacy.close();
    await kit.close();
    await logged.close();
    stdout.mockRestore();
  });
  beforeEach(async () => {
    await kit.reset();
  });
  const spies: jest.SpyInstance[] = [];
  const spy = <S extends jest.SpyInstance>(s: S): S => {
    spies.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of spies.splice(0)) s.mockRestore();
    await db.query(`DROP TRIGGER IF EXISTS s12_block_done ON "ExportJob"`); // L-013
    await kit.forget(shops.splice(0));
  });

  /** A shop with an owner and a couple of lines, an export started at `at` and run (a DONE file in storage). */
  const doneExport = async (at: Date) => {
    const owner = await kit.newUser();
    const shop = await createShop(kit.app, owner);
    shops.push(shop.id);
    const f = await seedF5Lite(owner, shop.id);
    kit.clock.set(at);
    await kit.reauth(owner); // a session whose token is valid at `at`
    const res = await startExport(kit, owner, shop.id);
    expect(res.status).toBe(202);
    const id = res.body.exportId as string;
    await kit.run.handle(id);
    return { owner, shop, id, ...f };
  };
  const seedF5Lite = async (owner: { id: string }, shopId: string) => {
    const product = await createProduct(
      kit.app,
      { id: shopId },
      { externalSku: 'SKU-L' },
    );
    await seedBulkLines(kit.app, {
      shopId,
      productId: product.id,
      buyerId: owner.id,
      orders: 3,
      perOrder: 2,
      at: new Date(T.getTime() - 20 * DAY),
    });
    return { product };
  };
  const rowOf = async (id: string) => kit.jobs.findById(id);
  const historyOf = (id: string) =>
    db.query<{ toStatus: string; reason: string | null; actor: string | null }>(
      `SELECT "toStatus", "reason", "actor" FROM "ExportJobHistory" WHERE "exportId" = :id ORDER BY "at", "id"`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
  const storage = () => kit.app.get(ObjectStorage);

  describe('retention (AS-51, AS-52)', () => {
    it('S12 AS-51: a file finished eight days ago is deleted and the export expires; one finished six days ago is untouched; a refused delete leaves it DONE and is retried', async () => {
      const old = await doneExport(T);
      const recent = await doneExport(new Date(T.getTime() + 2 * DAY));
      const oldKey = (await rowOf(old.id))!.fileKey!;
      const recentKey = (await rowOf(recent.id))!.fileKey!;
      expect(await storage().head(oldKey)).not.toBeNull();

      // eight days after the first export, six days after the second
      kit.clock.set(new Date(T.getTime() + 8 * DAY));
      await kit.reauth(old.owner);
      const first = await kit.maintenance.expireExports();

      expect(first.expired).toBe(1);
      expect((await rowOf(old.id))!.status).toBe('EXPIRED');
      expect(await storage().head(oldKey)).toBeNull();
      expect((await rowOf(recent.id))!.status).toBe('DONE');
      expect(await storage().head(recentKey)).not.toBeNull();
      const gone = await kit
        .as(old.owner)
        .get(`/api/shops/${old.shop.id}/order-exports/${old.id}/download`);
      expect([gone.status, gone.body.code]).toEqual([410, 'export_expired']);
      const historyBefore = await historyOf(old.id);
      expect((await kit.maintenance.expireExports()).expired).toBe(0);
      expect(await historyOf(old.id)).toEqual(historyBefore);
      expect(historyBefore.at(-1)).toMatchObject({
        toStatus: 'EXPIRED',
        reason: 'retention',
      });

      // a storage that refuses the delete: the export stays DONE, the failure is logged, the next run expires it
      kit.clock.set(new Date(T.getTime() + 10 * DAY)); // the second file is now eight days old
      const warn = spy(jest.spyOn(Logger.prototype, 'warn'));
      const realDelete = storage().delete.bind(storage());
      const refuse = spy(jest.spyOn(storage(), 'delete')).mockRejectedValue(
        new Error('storage refuses'),
      );
      expect((await kit.maintenance.expireExports()).expired).toBe(0);
      expect((await rowOf(recent.id))!.status).toBe('DONE');
      expect(
        warn.mock.calls.some(([m]) =>
          String(m).startsWith('order_export_expiry_delete_failed'),
        ),
      ).toBe(true);
      refuse.mockImplementation(realDelete);
      expect((await kit.maintenance.expireExports()).expired).toBe(1);
      expect((await rowOf(recent.id))!.status).toBe('EXPIRED');
      expect(await storage().head(recentKey)).toBeNull();
    });

    it('S12 AS-52: records finished over ninety days ago are purged with their history and any leftover file; active and recent ones stay; two runs at once end in the same state', async () => {
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      const other = await createShop(kit.app, owner);
      shops.push(shop.id, other.id);
      const longAgo = new Date(T.getTime() - 91 * DAY);
      const insert = async (
        shopId: string,
        status: string,
        at: Date,
        fileKey: string | null,
      ) => {
        const id = randomUUID();
        await db.query(
          `INSERT INTO "ExportJob" ("id", "shopId", "createdBy", "status", "fileKey", "createdAt", "updatedAt", "finishedAt")
           VALUES (:id, :shopId, :owner, :status, :fileKey, :at, :at, :finished)`,
          {
            replacements: {
              id,
              shopId,
              owner: owner.id,
              status,
              fileKey,
              at,
              finished: status === 'QUEUED' ? null : at,
            },
          },
        );
        await db.query(
          `INSERT INTO "ExportJobHistory" ("exportId", "shopId", "fromStatus", "toStatus", "at") VALUES (:id, :shopId, NULL, :status, :at)`,
          { replacements: { id, shopId, status, at } },
        );
        return id;
      };
      const leftover = `exports/${shop.id}/leftover/attempt-1-x.csv`;
      await storage().put(leftover, Buffer.from('old'), 'text/csv');
      const doneOld = await insert(shop.id, 'DONE', longAgo, leftover);
      const failedOld = await insert(shop.id, 'FAILED', longAgo, null);
      const cancelledOld = await insert(shop.id, 'CANCELLED', longAgo, null);
      const expiredOld = await insert(shop.id, 'EXPIRED', longAgo, null);
      const recent = await insert(
        shop.id,
        'DONE',
        new Date(T.getTime() - 10 * DAY),
        null,
      );
      const active = await insert(other.id, 'QUEUED', longAgo, null);

      const [a, b] = await Promise.all([
        kit.maintenance.purgeExports(),
        kit.maintenance.purgeExports(),
      ]);

      expect(a.purged + b.purged).toBe(4);
      for (const id of [doneOld, failedOld, cancelledOld, expiredOld]) {
        expect(await rowOf(id)).toBeNull();
        expect(await historyOf(id)).toEqual([]);
      }
      expect(await storage().head(leftover)).toBeNull();
      expect(await rowOf(recent)).not.toBeNull();
      expect(await rowOf(active)).not.toBeNull();
      expect((await kit.maintenance.purgeExports()).purged).toBe(0);
    });
  });

  describe('shop events (AS-53, AS-54, AS-55)', () => {
    const consumers = () => ({
      offboarding: kit.app.get(OrderExportOffboardingConsumer, {
        strict: false,
      }),
      deleted: kit.app.get(OrderExportShopDeletedConsumer, { strict: false }),
    });
    const started = (shopId: string) =>
      ShopOffboardingStarted.create(shopId, 3, {
        shopId,
        purgeAt: new Date(T.getTime() + 30 * DAY).toISOString(),
        shopVersion: 3,
      });
    const cancelled = (shopId: string) =>
      ShopOffboardingCancelled.create(shopId, 4, { shopId, shopVersion: 4 });
    const deleted = (shopId: string) =>
      ShopDeleted.create(shopId, 5, { shopId, shopVersion: 5 });

    it("S12 AS-53: shop_offboarding_started cancels the shop's active exports with reason shop_offboarding and leaves DONE ones and other shops alone; a duplicate delivery changes nothing more; the cancelled event is ignored", async () => {
      const queuedShop = await kit.newUser().then(async (owner) => {
        const shop = await createShop(kit.app, owner);
        shops.push(shop.id);
        const id = (await startExport(kit, owner, shop.id)).body
          .exportId as string;
        return { owner, shop, id };
      });
      const doneShop = await doneExport(T);
      const otherShop = await kit.newUser().then(async (owner) => {
        const shop = await createShop(kit.app, owner);
        shops.push(shop.id);
        const id = (await startExport(kit, owner, shop.id)).body
          .exportId as string;
        return { owner, shop, id };
      });
      const { offboarding } = consumers();

      await offboarding.project([started(queuedShop.shop.id)]);
      await offboarding.project([started(queuedShop.shop.id)]); // duplicate delivery
      await offboarding.project([started(doneShop.shop.id)]);

      expect((await rowOf(queuedShop.id))!.status).toBe('CANCELLED');
      expect(
        (await historyOf(queuedShop.id)).filter(
          (h) => h.toStatus === 'CANCELLED',
        ),
      ).toEqual([
        { toStatus: 'CANCELLED', reason: 'shop_offboarding', actor: null },
      ]);
      expect((await rowOf(doneShop.id))!.status).toBe('DONE');
      expect((await rowOf(otherShop.id))!.status).toBe('QUEUED');

      await offboarding.project([cancelled(otherShop.shop.id)]);
      await offboarding.project([cancelled(queuedShop.shop.id)]);
      expect((await rowOf(otherShop.id))!.status).toBe('QUEUED');
      expect((await rowOf(queuedShop.id))!.status).toBe('CANCELLED');
    });

    it("S12 AS-54: shop_deleted cancels active exports and removes the shop's files, rows and history; another shop is untouched; delivering it twice ends the same", async () => {
      const gone = await doneExport(T);
      const active = (await startExport(kit, gone.owner, gone.shop.id)).body
        .exportId as string;
      const kept = await doneExport(T);
      const keptKey = (await rowOf(kept.id))!.fileKey!;
      const { deleted: consumer } = consumers();
      expect(
        (await storage().list(`exports/${gone.shop.id}/`)).length,
      ).toBeGreaterThan(0);

      await consumer.project([deleted(gone.shop.id)]);
      await consumer.project([deleted(gone.shop.id)]);

      for (const id of [gone.id, active]) {
        expect(await rowOf(id)).toBeNull();
        expect(await historyOf(id)).toEqual([]);
      }
      expect(await storage().list(`exports/${gone.shop.id}/`)).toEqual([]);
      expect((await rowOf(kept.id))!.status).toBe('DONE');
      expect(await storage().head(keptKey)).not.toBeNull();
    });

    it('S12 AS-55: a started event after the deleted one has no effect; a malformed payload or an unknown version is dead-lettered with no effect', async () => {
      const gone = await doneExport(T);
      const { deleted: del, offboarding } = consumers();
      await del.project([deleted(gone.shop.id)]);

      await offboarding.project([started(gone.shop.id)]);
      expect(await rowOf(gone.id)).toBeNull();

      const bad = (payload: unknown, version = 1) =>
        ({ ...started(gone.shop.id), payload, version }) as never;
      for (const event of [
        bad({ shopId: 5 }),
        bad({}),
        bad({ shopId: gone.shop.id }, 99),
      ])
        await expect(offboarding.project([event])).rejects.toBeInstanceOf(
          PermanentError,
        );
      for (const event of [bad({ shopId: 5 }), bad({})])
        await expect(del.project([event])).rejects.toBeInstanceOf(
          PermanentError,
        );
    });
  });

  describe('cutover and boundaries (AS-56)', () => {
    it('S12 AS-56: the old export paths answer 404 everywhere (the orders app and a catalog-sync-only app); the new start puts one message on order-exports and none on catalog-imports', async () => {
      const f: F5 = await seedF5(kit);
      shops.push(...f.shopIds);
      const id = (await startExport(kit, f.U, f.S.id)).body.exportId as string;
      expect(kit.enqueued.filter((m) => m.queue === 'catalog-imports')).toEqual(
        [],
      );
      expect(
        kit.enqueued.filter((m) => m.queue === 'order-exports'),
      ).toHaveLength(1);

      const old = await kit
        .as(f.U)
        .post(`/api/shops/${f.S.id}/exports/orders`)
        .send({});
      const oldRead = await kit
        .as(f.U)
        .get(`/api/shops/${f.S.id}/exports/${id}`);
      expect([old.status, oldRead.status]).toEqual([404, 404]);

      // an app with only the catalog-sync import modules has no export route either
      const owner = await legacy.newUser();
      const shop = await createShop(legacy.app, owner);
      shops.push(shop.id);
      const post = await legacy
        .as(owner)
        .post(`/api/shops/${shop.id}/exports/orders`)
        .send({});
      const get = await legacy
        .as(owner)
        .get(`/api/shops/${shop.id}/exports/${id}`);
      expect([post.status, get.status]).toEqual([404, 404]);
    });
  });

  describe('events and observability (AS-58, AS-60)', () => {
    it('S12 AS-58: logs carry the ids and no row data, the metrics count status, lines, bytes, duration, queue wait, retries by code and downloads, and a download is audited once', async () => {
      await logged.reset();
      written.length = 0;
      const spans: Array<{
        name: string;
        attributes: Record<string, unknown>;
      }> = [];
      const realTracer = trace.getTracer.bind(trace);
      spy(jest.spyOn(trace, 'getTracer')).mockImplementation(
        (name: string, version?: string) => {
          const tracer = realTracer(name, version);
          if (name !== 'order-exports') return tracer;
          return new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop === 'startActiveSpan')
                return (...args: unknown[]) => {
                  spans.push({
                    name: String(args[0]),
                    attributes:
                      (args[1] as { attributes?: Record<string, unknown> })
                        ?.attributes ?? {},
                  });
                  return (
                    target.startActiveSpan as (...a: unknown[]) => unknown
                  )(...args);
                };
              return Reflect.get(target, prop, receiver) as unknown;
            },
          }) as Tracer;
        },
      );
      const metric = (name: string, labels: Record<string, string> = {}) =>
        MetricsRegistry.value(name, labels) ?? 0;
      const histo = (name: string) =>
        MetricsRegistry.histogramValue(name)?.count ?? 0;
      {
        const f = await seedF5(logged);
        shops.push(...f.shopIds);
        const before = {
          done: metric('order_export_finished_total', { status: 'DONE' }),
          failed: metric('order_export_finished_total', { status: 'FAILED' }),
          lines: metric('order_export_lines_total'),
          bytes: metric('order_export_bytes_total'),
          retries: metric('order_export_retries_total', {
            code: 'storage_unavailable',
          }),
          downloads: metric('order_export_downloads_total'),
          duration: histo('order_export_duration_seconds'),
          wait: histo('order_export_queue_wait_seconds'),
        };

        const id = (await startExport(logged, f.U, f.S.id)).body
          .exportId as string;
        logged.clock.advance(5_000);
        await logged.run.handle(id);
        const stored = await logged.jobs.findById(id);
        const link = await logged
          .as(f.U)
          .get(`/api/shops/${f.S.id}/order-exports/${id}/download`);
        expect(link.status).toBe(200);
        const failing = (await startExport(logged, f.X, f.S2.id)).body
          .exportId as string;
        logged.storageControl.failAfter(1);
        for (let i = 0; i < 3; i++) await logged.run.handle(failing);

        const metricsDelta = {
          done:
            metric('order_export_finished_total', { status: 'DONE' }) -
            before.done,
          failed:
            metric('order_export_finished_total', { status: 'FAILED' }) -
            before.failed,
          lines: metric('order_export_lines_total') - before.lines,
          bytes: metric('order_export_bytes_total') - before.bytes,
          retries:
            metric('order_export_retries_total', {
              code: 'storage_unavailable',
            }) - before.retries,
          downloads: metric('order_export_downloads_total') - before.downloads,
          duration: histo('order_export_duration_seconds') - before.duration,
          wait: histo('order_export_queue_wait_seconds') - before.wait,
        };
        expect(metricsDelta).toEqual({
          done: 1,
          failed: 1,
          lines: 5,
          bytes: stored!.bytesWritten,
          retries: 2,
          downloads: 1,
          duration: 2, // the finished and the failed run
          wait: 3 + 1, // every claim measures how long the export waited: 1 done + 3 attempts of the failing one
        });
        expect(
          MetricsRegistry.labelSets('order_export_finished_total'),
        ).toEqual(
          expect.not.arrayContaining([
            expect.objectContaining({ exportId: expect.anything() }),
          ]),
        );

        const lines = written
          .join('')
          .split('\n')
          .filter((line) => line.trim().startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((l) => String(l.event ?? '').startsWith('order_export'));
        const byEvent = (event: string) =>
          lines.filter((l) => l.event === event);
        expect(byEvent('order_export_downloaded')).toHaveLength(1);
        expect(byEvent('order_export_finished')).toHaveLength(1);
        expect(byEvent('order_export_failed')).toHaveLength(1);
        expect(byEvent('order_export_retry')).toHaveLength(2);
        for (const l of lines) {
          expect(l.exportId).toEqual(expect.any(String));
          expect(l.shopId).toEqual(expect.any(String));
        }
        // Runs are traced (the log lines inside a span carry its trace id once an SDK is registered); the request that
        // downloads carries its request id.
        const runSpans = spans.filter((s) => s.name === 'order_export.run');
        expect(runSpans).toHaveLength(4); // one per claim: the done export and the three attempts of the failing one
        for (const s of runSpans)
          expect(Object.keys(s.attributes).sort()).toEqual([
            'attempt',
            'exportId',
            'shopId',
          ]);
        expect(byEvent('order_export_downloaded')[0].requestId).toEqual(
          expect.any(String),
        );
        const raw = JSON.stringify(lines);
        for (const forbidden of [
          'Cable',
          'SKU-P',
          'He said',
          '1900',
          'http',
          'exports/',
          'attempt-',
        ])
          expect(raw).not.toContain(forbidden);
        await logged.forget(f.shopIds);
      }
    });

    it('S12 AS-60: exactly one finished event per DONE, FAILED and CANCELLED export, parsed by the contract; none for a retry, a requeue, an expiry or a purge; a rolled-back final update leaves no event and the export RUNNING', async () => {
      const owner = await kit.newUser();
      const shop = await createShop(kit.app, owner);
      shops.push(shop.id);
      await seedF5Lite(owner, shop.id);
      const begin = async () =>
        (await startExport(kit, owner, shop.id)).body.exportId as string;
      const events = async (id: string) =>
        (await outboxRowsFor(db, id)).filter(
          (o) => o.type === 'orderexport.finished',
        );

      // DONE
      const done = await begin();
      await kit.run.handle(done);
      const doneEvents = await events(done);
      expect(doneEvents).toHaveLength(1);
      const envelope = eventEnvelopeSchema.parse(doneEvents[0].payload);
      expect(envelope).toMatchObject({
        type: 'orderexport.finished',
        version: 1,
        aggregateId: done,
      });
      expect(() =>
        orderExportEventSchemas['orderexport.finished'].parse(envelope.payload),
      ).not.toThrow();
      expect(doneEvents[0]).toMatchObject({
        topic: 'order_exports.events',
        aggregateId: done,
      });
      // expiry and purge add none
      kit.clock.set(new Date(T.getTime() + 8 * DAY));
      await kit.maintenance.expireExports();
      expect(await events(done)).toHaveLength(1);
      kit.clock.set(new Date(T.getTime() + 100 * DAY));
      await kit.maintenance.purgeExports();
      kit.clock.set(T);

      // CANCELLED
      const cancelled = await begin();
      await kit
        .as(owner)
        .post(`/api/shops/${shop.id}/order-exports/${cancelled}/cancel`)
        .send();
      expect(await events(cancelled)).toHaveLength(1);
      expect((await events(cancelled))[0].payload).toMatchObject({
        payload: { status: 'CANCELLED' },
      });

      // a retry and a requeue add none; the final failure adds one
      const failing = await begin();
      kit.storageControl.failAfter(1);
      await kit.run.handle(failing);
      expect(await events(failing)).toHaveLength(0);
      await kit.run.handle(failing);
      expect(await events(failing)).toHaveLength(0);
      await kit.run.handle(failing);
      const failed = await events(failing);
      expect(failed).toHaveLength(1);
      expect(failed[0].payload).toMatchObject({
        payload: { status: 'FAILED', failureCode: 'storage_unavailable' },
      });
      kit.storageControl.reset();

      // a trigger that refuses the final update: nothing is written, the export is still RUNNING, the attempt's file is gone
      const blocked = await begin();
      await db.query(`
        CREATE OR REPLACE FUNCTION s12_block_done() RETURNS trigger AS $$
        BEGIN IF NEW."status" = 'DONE' THEN RAISE EXCEPTION 's12 forced rollback'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await db.query(
        `CREATE TRIGGER s12_block_done BEFORE UPDATE ON "ExportJob" FOR EACH ROW EXECUTE FUNCTION s12_block_done()`,
      );
      await expect(kit.run.handle(blocked)).rejects.toThrow();
      await db.query(`DROP TRIGGER s12_block_done ON "ExportJob"`);
      expect(await events(blocked)).toHaveLength(0);
      expect((await rowOf(blocked))!.status).toBe('RUNNING');
      expect((await historyOf(blocked)).map((h) => h.toStatus)).toEqual([
        'QUEUED',
        'RUNNING',
      ]);
      expect(await storage().list(`exports/${shop.id}/${blocked}/`)).toEqual(
        [],
      );
      kit.clock.advance(6 * MIN);
      expect((await kit.maintenance.recoverStalled()).requeued).toBe(1);
      expect(await events(blocked)).toHaveLength(0);
      await kit.run.handle(blocked);
      expect(await events(blocked)).toHaveLength(1);
    });
  });

  describe('configuration (AS-59)', () => {
    it.each([
      ['ORDER_EXPORT_BATCH_SIZE', '0', 'orders_export_batch_size'],
      ['ORDER_EXPORT_ROW_LIMIT', '0', 'orders_export_row_limit'],
      [
        'ORDER_EXPORT_FILE_RETENTION_DAYS',
        '0',
        'orders_export_file_retention_days',
      ],
      [
        'ORDER_EXPORT_RECORD_RETENTION_DAYS',
        '0',
        'orders_export_record_retention_days',
      ],
      ['ORDER_EXPORT_LEASE_SEC', '100', 'orders_export_lease_seconds'], // below twice the heartbeat (60)
    ])(
      'S12 AS-59: the app does not start with %s=%s and the message names the key',
      async (variable, value, key) => {
        await expect(
          createExportApp({ env: { [variable]: value } }),
        ).rejects.toThrow(new RegExp(key));
      },
    );

    it('S12 AS-59: in production the user-content origin is required for download links', () => {
      const values: Record<string, unknown> = {};
      const run = (production: boolean) =>
        ordersExportRule({ get: (k) => values[k], production });
      expect(run(false)).toEqual([]);
      expect(run(true).join(' ')).toContain('usercontent_origin');
      values.usercontent_origin = 'https://files.example.com';
      expect(run(true)).toEqual([]);
    });
  });

  describe('jobs (S49)', () => {
    it('S12 T060: the three job types are declared with a payload contract and their schedules are accepted', async () => {
      const jobs = kit.app.get(OrderExportJobs, { strict: false });
      await expect(jobs.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(await jobs.recover()).toMatchObject({ requeued: 0 });
    });
  });
});
