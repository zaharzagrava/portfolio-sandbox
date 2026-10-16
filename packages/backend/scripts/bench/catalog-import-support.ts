/**
 * Shared by the bulk-import benchmark and kill loop (S07 SC-001, SC-002, SC-003, SC-006): boots the real import
 * modules over the throwaway stack, makes shops, writes a generated catalog file into object storage and hands out
 * runners. Not a jest file and not a build gate.
 */
import { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK } from '../../libs/common/core/clock';
import { RealtimePublisher } from '../../libs/infrastructure/realtime';
import { ObjectStorage } from '../../libs/infrastructure/storage/object-storage.port';
import { createCatalogApp } from '../../test/utils/catalog-app';
import { createShop } from '../../test/utils/tenancy-fixtures';
import { ImportRunnerService } from '../../libs/domains/catalog-sync/application/import-runner.service';
import {
  CatalogImportModule,
  CatalogImportRunModule,
} from '../../libs/domains/catalog-sync/catalog-import.module';
import {
  IMPORT_CATALOG,
  IMPORT_PIPELINE,
  IMPORT_PUBLISHER,
  IMPORT_REPOSITORY,
  IMPORT_SCANNER,
  IMPORT_SHOP_STATUS,
  IMPORT_STORAGE,
  type ImportRepository,
} from '../../libs/domains/catalog-sync/domain/ports';
import {
  IMPORT_CONFIG,
  importSourceKey,
} from '../../libs/domains/catalog-sync/domain/import-limits';

export const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
export const flag = (name: string) => process.argv.includes(`--${name}`);

export interface LiveEvent {
  at: number;
  topic: string;
  type: string;
}

export async function boot() {
  // the benchmark measures the pipeline, not the malware scanner: no clamd in the throwaway stack
  process.env.MEDIA_SCANNER_DISABLED = 'true';
  const events: LiveEvent[] = [];
  const ctx = await createCatalogApp({
    extraImports: [CatalogImportModule, CatalogImportRunModule],
    overrides: [
      {
        provide: RealtimePublisher,
        useValue: {
          publish: (topic: string, type: string) => {
            events.push({ at: Date.now(), topic, type });
            return Promise.resolve({ published: true, id: '0-0' });
          },
        },
      },
    ],
  });
  const app: INestApplication = ctx.app;
  const get = <T>(token: unknown): T =>
    app.get(token as never, { strict: false });
  const repo = get<ImportRepository>(IMPORT_REPOSITORY);
  const storage = get<ObjectStorage>(ObjectStorage);
  return {
    ctx,
    app,
    events,
    repo,
    storage,
    db: get<Sequelize>(Sequelize),
    runner: get<ImportRunnerService>(ImportRunnerService),
    /** Another worker over the same stores. */
    newRunner: () =>
      new ImportRunnerService(
        repo,
        get(IMPORT_STORAGE),
        get(IMPORT_SCANNER),
        get(IMPORT_CATALOG),
        get(IMPORT_PUBLISHER),
        get(IMPORT_SHOP_STATUS),
        get(IMPORT_PIPELINE),
        get(IMPORT_CONFIG),
        get(CLOCK),
      ),
    async shop() {
      const owner = await ctx.newUser();
      const shop = await createShop(app, owner);
      return { shopId: shop.id as string, ownerId: owner.id as string };
    },
  };
}
export type Booted = Awaited<ReturnType<typeof boot>>;

/** A catalog CSV of `rows` records, produced lazily so a 5 GiB-class file never sits in memory. */
export function catalogStream(
  rows: number,
  prefix: string,
): { body: Readable; size: number } {
  const header = 'sku,title,description,price,stock,category,brand\n';
  const line = (i: number) =>
    `${prefix}-${i},Item ${i},${'Generated description for a benchmark item. '.repeat(4)},${(i % 9000) / 100 + 1},${i % 50},Category ${i % 20},Brand ${i % 40}\n`;
  let size = Buffer.byteLength(header);
  for (let i = 1; i <= Math.min(rows, 1000); i++)
    size += Buffer.byteLength(line(i));
  size = rows <= 1000 ? size : Math.round(size + (size / 1000) * (rows - 1000)); // exact size is measured after the write
  const body = Readable.from(
    (function* () {
      yield header;
      let chunk = '';
      for (let i = 1; i <= rows; i++) {
        chunk += line(i);
        if (chunk.length > 1 << 20) {
          yield chunk;
          chunk = '';
        }
      }
      if (chunk) yield chunk;
    })(),
  );
  return { body, size };
}

/** An `UPLOADED` import of a generated file, as the API leaves it after `complete`. */
export async function uploadedImport(
  b: Booted,
  seller: { shopId: string; ownerId: string },
  rows: number,
  prefix: string,
): Promise<string> {
  const id = uuidv7();
  const key = importSourceKey(seller.shopId, id);
  const { body } = catalogStream(rows, prefix);
  await b.storage.put(key, body, 'text/csv');
  const head = await b.storage.head(key);
  if (!head) throw new Error(`${key} was not stored`);
  const inserted = await b.repo.insertPending({
    id,
    shopId: seller.shopId,
    createdBy: seller.ownerId,
    fileName: `${prefix}.csv`,
    sizeBytes: head.size,
    storageKey: key,
    now: new Date(),
  });
  if (inserted.kind !== 'created') throw new Error('shop is at its cap');
  const moved = await b.repo.transition({
    importId: id,
    shopId: seller.shopId,
    from: 'PENDING_UPLOAD',
    to: 'UPLOADED',
    now: new Date(),
  });
  if (!moved) throw new Error('could not move to UPLOADED');
  return id;
}

/** Samples RSS once a second until `stop()`; returns the peak. */
export function sampleRss(): { stop: () => number } {
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1000);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage().rss);
    },
  };
}

export const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
