import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import {
  ProductImportService,
  ProductQueryService,
  type ProductDto,
} from '@app/domains/catalog';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { productIdsOf } from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { Module } from '@nestjs/common';
import {
  CatalogImportModule,
  CatalogImportRunModule,
  CatalogImportCoreModule,
} from '../catalog-import.module';
import { ImportLifecycleService } from '../application/import-lifecycle.service';
import { ImportRunnerService } from '../application/import-runner.service';
import { ImportStartService } from '../application/import-start.service';
import { IMPORT_CONFIG, importSourceKey } from '../domain/import-limits';
import { CLOCK } from '@app/common/core/clock';
import {
  IMPORT_CATALOG,
  IMPORT_PIPELINE,
  IMPORT_PUBLISHER,
  IMPORT_QUEUE,
  IMPORT_REPOSITORY,
  IMPORT_SCANNER,
  IMPORT_SHOP_STATUS,
  IMPORT_STORAGE,
  type ImportJobRecord,
  type ImportQueuePort,
  type ImportRepository,
  type ImportStoragePort,
} from '../domain/ports';
import { ImportJobTopicsModule } from '../realtime-topics.module';
import { ImportConsumer } from '../infra/import.consumer';
import {
  ImportOffboardingConsumer,
  ImportShopDeletedConsumer,
} from '../infra/import-lifecycle.consumers';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import { FakeClamd } from '../test/fakes/fake-clamd';
import { StorageProbe } from '../test/fakes/storage-probe';

export const T = new Date('2026-10-16T10:00:00.000Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** The consumers of the shop events without the Kafka framework: specs call `project` directly. */
@Module({
  imports: [CatalogImportCoreModule],
  providers: [ImportOffboardingConsumer, ImportShopDeletedConsumer],
  exports: [ImportOffboardingConsumer, ImportShopDeletedConsumer],
})
class ImportProbeModule {}

/** The live channel's transport: records every publish with its replay flag, or refuses while `down`. */
export class RecordingRealtime {
  readonly events: Array<{
    topic: string;
    type: string;
    data: Record<string, unknown>;
    replay: boolean;
  }> = [];
  down = false;

  publish(
    topic: string,
    type: string,
    data: Record<string, unknown>,
    options: { replay?: boolean } = {},
  ): Promise<{ published: boolean; id: string | null }> {
    if (this.down) return Promise.reject(new Error('realtime hub is down'));
    this.events.push({ topic, type, data, replay: options.replay ?? true });
    return Promise.resolve({ published: true, id: '0-0' });
  }

  of(importId: string) {
    return this.events.filter((e) => e.topic === `import:${importId}`);
  }

  reset(): void {
    this.events.length = 0;
    this.down = false;
  }
}

export interface Seller {
  shop: { id: string };
  /** Owner of the shop (writer). */
  owner: TestUser;
}

export interface ImportKit extends CatalogTestApp {
  db: Sequelize;
  rt: RecordingRealtime;
  clamd: FakeClamd;
  probe: StorageProbe;
  storage: ObjectStorage;
  /** The import's own storage port (keys, parts, report). */
  importStorage: ImportStoragePort;
  repo: ImportRepository;
  runner: ImportRunnerService;
  starts: ImportStartService;
  lifecycle: ImportLifecycleService;
  offboarding: ImportOffboardingConsumer;
  deleted: ImportShopDeletedConsumer;
  /** Every `enqueue` call the app made (the real queue is not touched). */
  enqueued: Array<{ queue: string; body: unknown; options?: unknown }>;
  /** A consumer that is not started: `process` is the entry of one delivery. */
  consumer(): ImportConsumer;
  /** Another worker: its own runner (own set of active runs, own shutdown), over the same stores. */
  newRunner(): ImportRunnerService;
  /** Forgets the catalog calls seen so far. */
  resetCalls(): void;
  /** Sets the shop's status, as tenancy would after a suspension or the start of a deletion. */
  setShopStatus(
    shopId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETING',
  ): Promise<void>;
  /** A shop with an owner. */
  seller(): Promise<Seller>;
  /** A member of the shop with a role other than owner. */
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<TestUser>;
  /** A job whose parts were uploaded and completed, as the API leaves it: object in storage, status `UPLOADED`. */
  uploaded(
    seller: { shop: { id: string }; owner: { id: string } },
    file: Buffer,
    options?: { fileName?: string; createdAt?: Date },
  ): Promise<string>;
  /** Runs one delivery of the message through the runner. */
  deliver(
    importId: string,
    receiveCount?: number,
  ): ReturnType<ImportRunnerService['handle']>;
  job(importId: string): Promise<ImportJobRecord>;
  history(importId: string): Promise<
    Array<{
      fromStatus: string | null;
      toStatus: string;
      reason: string | null;
    }>
  >;
  finishedEvents(
    importId: string,
  ): Promise<Array<{ type: string; payload: Record<string, unknown> }>>;
  /** The shop's products as the catalog's R1 query service reports them, keyed by external SKU. */
  productsOf(shopId: string): Promise<Map<string, ProductDto>>;
  /** Calls the catalog's import command received, in order (observation: the real command still runs). */
  catalogCalls(): Array<{ shopId: string; skus: string[]; source: unknown }>;
  /** The stored bytes of an object. */
  objectText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** Removes the imports, history and outbox rows of these shops (a spec cleans what it made, L-006). */
  forget(shopIds: string[]): Promise<void>;
}

/** The real app the import specs run against (S07 test-plan.md): HTTP module, runner, shop-event consumers, over real Postgres, Redis, MinIO and the catalog. */
export async function createImportApp(
  /** The live topic `import:<id>` is registered unless `withTopics` is false: a spec asks the registry who may follow it. */
  options: { env?: Record<string, string>; withTopics?: boolean } = {},
): Promise<ImportKit> {
  const clamd = new FakeClamd();
  const port = await clamd.start();
  const rt = new RecordingRealtime();
  // `.env.test` disables the scanner (a string setting, so even "false" would count as set); the import specs scan for
  // real against the fake clamd, so the setting is removed for the boot and restored after.
  const scannerSetting = process.env.MEDIA_SCANNER_DISABLED;
  delete process.env.MEDIA_SCANNER_DISABLED;
  let base: CatalogTestApp;
  try {
    base = await createCatalogApp({
      extraImports: [
        CatalogImportModule,
        CatalogImportRunModule,
        ImportProbeModule,
        ...(options.withTopics === false ? [] : [ImportJobTopicsModule]),
      ],
      overrides: [{ provide: RealtimePublisher, useValue: rt }],
      env: {
        CLAMAV_HOST: `127.0.0.1:${port}`,
        IMPORT_SCAN_INACTIVITY_MS: '1500',
        ...options.env,
      },
    });
  } finally {
    if (scannerSetting !== undefined)
      process.env.MEDIA_SCANNER_DISABLED = scannerSetting;
  }
  base.clock.set(T);
  const app: INestApplication = base.app;
  const db = app.get(Sequelize);
  const storage = app.get(ObjectStorage);
  const probe = new StorageProbe();
  probe.install(storage);

  const enqueued: ImportKit['enqueued'] = [];
  const queue = app.get(TaskQueue);
  // armed again by every `reset()`: a spec's `jest.restoreAllMocks()` would otherwise drop them for the tests after it
  const arm = () => ({
    enqueueSpy: jest
      .spyOn(queue, 'enqueue')
      .mockImplementation((name: string, body: unknown, opts?: unknown) => {
        enqueued.push({ queue: name, body, options: opts });
        return Promise.resolve('m-' + randomUUID());
      }),
    catalogSpy: jest.spyOn(
      app.get(ProductImportService, { strict: false }),
      'upsertFromExternal',
    ),
  });
  let { enqueueSpy, catalogSpy } = arm();
  const repo = app.get<ImportRepository>(IMPORT_REPOSITORY, { strict: false });
  const importStorage = app.get<ImportStoragePort>(IMPORT_STORAGE, {
    strict: false,
  });

  const kit: ImportKit = {
    ...base,
    db,
    rt,
    clamd,
    probe,
    storage,
    importStorage,
    repo,
    runner: app.get(ImportRunnerService, { strict: false }),
    starts: app.get(ImportStartService, { strict: false }),
    lifecycle: app.get(ImportLifecycleService, { strict: false }),
    offboarding: app.get(ImportOffboardingConsumer, { strict: false }),
    deleted: app.get(ImportShopDeletedConsumer, { strict: false }),
    enqueued,
    consumer: () =>
      new ImportConsumer(
        queue,
        kit.runner,
        app.get<ImportQueuePort>(IMPORT_QUEUE, { strict: false }),
        app.get(IMPORT_CONFIG, { strict: false }),
      ),
    newRunner: () =>
      new ImportRunnerService(
        repo,
        importStorage,
        app.get(IMPORT_SCANNER, { strict: false }),
        app.get(IMPORT_CATALOG, { strict: false }),
        app.get(IMPORT_PUBLISHER, { strict: false }),
        app.get(IMPORT_SHOP_STATUS, { strict: false }),
        app.get(IMPORT_PIPELINE, { strict: false }),
        app.get(IMPORT_CONFIG, { strict: false }),
        app.get(CLOCK, { strict: false }),
      ),
    resetCalls: () => catalogSpy.mockClear(),
    async setShopStatus(shopId, status) {
      await new TenancyFixture(db).setShopStatus(shopId, status);
    },
    async seller() {
      const owner = await base.newUser();
      const shop = await createShop(app, owner);
      return { shop: { id: shop.id }, owner };
    },
    async member(shopId, role) {
      const user = await base.newUser();
      await addMember(app, shopId, user.id, role);
      return user;
    },
    async uploaded(seller, file, opts = {}) {
      const id = uuidv7();
      const key = importSourceKey(seller.shop.id, id);
      const inserted = await repo.insertPending({
        id,
        shopId: seller.shop.id,
        createdBy: seller.owner.id,
        fileName: opts.fileName ?? 'catalog.csv',
        sizeBytes: file.length,
        storageKey: key,
        now: opts.createdAt ?? base.clock.now(),
      });
      if (inserted.kind !== 'created') throw new Error('shop is at its cap');
      await storage.put(key, file, 'text/csv');
      const moved = await repo.transition({
        importId: id,
        shopId: seller.shop.id,
        from: 'PENDING_UPLOAD',
        to: 'UPLOADED',
        now: base.clock.now(),
      });
      if (!moved) throw new Error('could not move to UPLOADED');
      return id;
    },
    deliver: (importId, receiveCount = 1) =>
      kit.runner.handle(importId, receiveCount),
    async job(importId) {
      const found = await repo.findById(importId);
      if (!found) throw new Error(`import ${importId} not found`);
      return found;
    },
    async history(importId) {
      return db.query(
        `SELECT "fromStatus", "toStatus", "reason" FROM "ImportJobHistory" WHERE "importId" = :importId ORDER BY "id"`,
        { type: QueryTypes.SELECT, replacements: { importId } },
      );
    },
    async finishedEvents(importId) {
      return (await outboxRowsFor(db, importId))
        .filter((r) => r.kind === 'event')
        .map((r) => {
          const envelope = r.payload as {
            type: string;
            payload: Record<string, unknown>;
          };
          return { type: envelope.type, payload: envelope.payload };
        });
    },
    async productsOf(shopId) {
      const ids = await productIdsOf(app, shopId);
      const query = app.get(ProductQueryService, { strict: false });
      const out = new Map<string, ProductDto>();
      for (let at = 0; at < ids.length; at += 500) {
        const found = await query.getProductsByIds(ids.slice(at, at + 500));
        for (const p of found.values())
          if (p.externalSku) out.set(p.externalSku, p);
      }
      return out;
    },
    catalogCalls: () =>
      catalogSpy.mock.calls.map(([shopId, items, source]) => ({
        shopId,
        skus: (items as Array<{ externalSku: string }>).map(
          (i) => i.externalSku,
        ),
        source,
      })),
    async objectText(key) {
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.getStream(key))
        chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
    async exists(key) {
      return (await storage.head(key)) !== null;
    },
    async forget(shopIds) {
      if (shopIds.length === 0) return;
      const ids = (
        await db.query<{ id: string }>(
          `SELECT "id" FROM "ImportJob" WHERE "shopId" IN (:shopIds)`,
          { type: QueryTypes.SELECT, replacements: { shopIds } },
        )
      ).map((r) => r.id);
      for (const shopId of shopIds)
        await importStorage.deletePrefix(`imports/${shopId}/`);
      if (ids.length) {
        await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
          replacements: { ids },
        });
        await db.query(
          `DELETE FROM "ImportJobHistory" WHERE "importId" IN (:ids)`,
          {
            replacements: { ids },
          },
        );
        await db.query(`DELETE FROM "ImportJob" WHERE "id" IN (:ids)`, {
          replacements: { ids },
        });
      }
    },
    async reset() {
      rt.reset();
      probe.reset();
      clamd.reset();
      enqueued.length = 0;
      ({ enqueueSpy, catalogSpy } = arm());
      catalogSpy.mockClear();
      await base.reset();
      base.clock.set(T);
    },
    async close() {
      enqueueSpy.mockRestore();
      catalogSpy.mockRestore();
      probe.uninstall();
      await clamd.stop();
      await base.close();
    },
  };
  return kit;
}

// ---------------------------------------------------------------- files

/** A catalog CSV of `rows` records; `bad` are 1-based record numbers made invalid (blank title, price `abc`, stock `-1`). */
export function catalogCsv(
  rows: number,
  options: {
    bad?: number[];
    prefix?: string;
    bom?: boolean;
    eol?: string;
    price?: (row: number) => string;
    withStock?: boolean;
    /** Length of each description: a way to make a file big without many rows (the catalog write is the slow part). */
    descriptionLength?: number;
  } = {},
): Buffer {
  const eol = options.eol ?? '\n';
  const prefix = options.prefix ?? 'SKU';
  const bad = new Set(options.bad ?? []);
  const header =
    'sku,title,description,price,' +
    (options.withStock === false ? '' : 'stock,') +
    'category,brand';
  const lines = Array.from({ length: rows }, (_, i) => {
    const n = i + 1;
    const price = options.price ? options.price(n) : `${(n % 50) + 1}.99`;
    if (bad.has(n))
      return `${prefix}-${n},,"no title",abc,${options.withStock === false ? '' : '-1,'}cables,`;
    const description = options.descriptionLength
      ? 'd'.repeat(options.descriptionLength)
      : '2 m';
    return `${prefix}-${n},"Cable ${n}, braided","${description}",${price},${options.withStock === false ? '' : `${n % 7},`}cables,Anker`;
  });
  return Buffer.from(
    (options.bom === false ? '' : '﻿') + header + eol + lines.join(eol) + eol,
  );
}

/** The same catalog as JSON lines. */
export function catalogJsonl(rows: number, prefix = 'SKU'): Buffer {
  return Buffer.from(
    Array.from({ length: rows }, (_, i) => {
      const n = i + 1;
      return JSON.stringify({
        sku: `${prefix}-${n}`,
        title: `Cable ${n}, braided`,
        description: '2 m',
        price: `${(n % 50) + 1}.99`,
        stock: n % 7,
        category: 'cables',
        brand: 'Anker',
      });
    }).join('\n') + '\n',
  );
}
