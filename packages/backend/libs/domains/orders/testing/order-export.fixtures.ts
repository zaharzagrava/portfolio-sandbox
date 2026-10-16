import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import type { TestUser } from '@app/test/utils/catalog-app';
import { Module } from '@nestjs/common';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { OrderExportMaintenanceService } from '../application/order-export-maintenance.service';
import { OrderExportJobs } from '../infra/order-export.jobs';
import {
  OrderExportOffboardingConsumer,
  OrderExportShopDeletedConsumer,
} from '../infra/order-export.tenancy.consumers';
import { OrderExportCoreModule } from '../order-export-core.module';
import { OrderExportRunService } from '../application/order-export-run.service';
import {
  EXPORT_JOBS,
  EXPORT_LINES,
  type ExportJobsPort,
  type ExportLinesPort,
} from '../domain/export-ports';
import { OrderExportRunModule } from '../order-export-worker.module';
import { OrderExportModule } from '../order-export.module';
import { OrderExportTopicsModule } from '../order-export-topics.module';
import { createOrdersApp, type OrdersTestApp } from './orders-app';

/** The event consumers and the jobs without the Kafka framework: specs call `project` and the handlers directly. */
@Module({
  imports: [OrderExportCoreModule, JobsModule],
  providers: [
    OrderExportOffboardingConsumer,
    OrderExportShopDeletedConsumer,
    OrderExportJobs,
  ],
  exports: [
    OrderExportOffboardingConsumer,
    OrderExportShopDeletedConsumer,
    OrderExportJobs,
  ],
})
class OrderExportProbeModule {}

/** The frozen "now" of the export specs (spec.md notation). */
export const T = new Date('2026-10-05T09:00:00.000Z');
export const DAY = 86_400_000;
export const MIN = 60_000;
export const CSV_BOM = '﻿';
export const HEADER =
  'order_id,shop_order_id,created_at,shop_order_status,currency,product_id,sku,title,quantity,unit_price_minor,discount_minor,line_total_minor';

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

  of(exportId: string) {
    return this.events.filter((e) => e.topic === `order-export:${exportId}`);
  }

  reset(): void {
    this.events.length = 0;
    this.down = false;
  }
}

type PutArgs = Parameters<ObjectStorage['put']>;

/**
 * A wrapper over the storage port's `put` for the fault and backpressure cases: it can hold the upload (storage
 * accepts nothing until `release()`), fail it after some bytes, or go silent after some bytes. It always forwards the
 * caller's abort signal, so an aborted upload ends here too.
 */
export class StorageControl {
  private holdGate: { open: () => void; wait: Promise<void> } | null = null;
  private reachedResolve: (() => void) | null = null;
  private failAt: number | null = null;
  private failOnce = false;
  private stallAt: number | null = null;
  /** Resolves when the first chunk reaches the (held) storage. */
  reached: Promise<void> = Promise.resolve();
  readonly keys: string[] = [];
  /** How many chunks the storage side consumed. */
  chunks = 0;

  hold(): void {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    this.holdGate = { open, wait };
    this.reached = new Promise<void>(
      (resolve) => (this.reachedResolve = resolve),
    );
  }

  release(): void {
    this.holdGate?.open();
    this.holdGate = null;
  }

  /** The upload fails once more than `bytes` arrived; with `once` only the first upload fails. */
  failAfter(bytes: number, options: { once?: boolean } = {}): void {
    this.failAt = bytes;
    this.failOnce = options.once ?? false;
  }

  stallAfter(bytes: number): void {
    this.stallAt = bytes;
  }

  reset(): void {
    this.release();
    this.failAt = null;
    this.stallAt = null;
    this.keys.length = 0;
    this.chunks = 0;
  }

  wrap(original: ObjectStorage['put']): ObjectStorage['put'] {
    return (key: string, body, contentType, options) => {
      this.keys.push(key);
      if (
        !(body instanceof Readable) ||
        (!this.holdGate && this.failAt === null && this.stallAt === null)
      )
        return original(key, body, contentType, options);
      const signal = options?.signal;
      const source = body;
      const out = new PassThrough();
      void (async () => {
        let seen = 0;
        try {
          if (this.holdGate) {
            this.reachedResolve?.();
            await Promise.race([
              this.holdGate.wait,
              new Promise<void>((_, reject) =>
                signal?.addEventListener('abort', () =>
                  reject(new Error('aborted')),
                ),
              ),
            ]);
          }
          for await (const chunk of source) {
            this.chunks += 1;
            const buffer = Buffer.from(chunk as string | Buffer);
            seen += buffer.length;
            if (this.failAt !== null && seen > this.failAt) {
              if (this.failOnce) this.failAt = null;
              throw new Error('storage is down');
            }
            if (this.stallAt !== null && seen > this.stallAt)
              await new Promise<void>((_, reject) =>
                signal?.addEventListener('abort', () =>
                  reject(new Error('aborted')),
                ),
              );
            if (!out.write(buffer))
              await new Promise((r) => out.once('drain', r));
          }
          out.end();
        } catch (error) {
          out.destroy(error as Error);
        }
      })();
      return original(key, out, contentType, options);
    };
  }
}

export interface ExportKit extends OrdersTestApp {
  jobs: ExportJobsPort;
  lines: ExportLinesPort;
  run: OrderExportRunService;
  maintenance: OrderExportMaintenanceService;
  rt: RecordingRealtime;
  storageControl: StorageControl;
  /** Every `enqueue` call the app made (the real queue is not touched). */
  enqueued: Array<{ queue: string; body: unknown; options?: unknown }>;
  /** Calls to the catalog lookup `getProductsByIds`: how many ids, which options. */
  skuCalls: Array<{ ids: number; options: unknown }>;
  /** Runs at the start of every catalog lookup, i.e. once per batch (a spec ticks the clock or reads the job here). */
  hooks: {
    onLookup?: () => void | Promise<void>;
    /** Runs inside the start request, just before its queue message is sent (holds a request "in flight"). */
    onEnqueue?: () => void | Promise<void>;
  };
  /** Lines pulled from the order store by the export reader. */
  linesRead(): number;
  resetLinesRead(): void;
  /** The bytes of a stored export file. */
  fileOf(exportId: string): Promise<string>;
  /** Removes the exports, their history and outbox rows of these shops (a spec cleans what it made, L-006). */
  forget(shopIds: string[]): Promise<void>;
}

export async function createExportApp(
  options: { env?: Record<string, string>; structuredLogger?: boolean } = {},
): Promise<ExportKit> {
  const rt = new RecordingRealtime();
  const base = await createOrdersApp({
    extraImports: [
      OrderExportModule,
      OrderExportRunModule,
      OrderExportTopicsModule,
      OrderExportProbeModule,
    ],
    overrides: [{ provide: RealtimePublisher, useValue: rt }],
    env: options.env,
    structuredLogger: options.structuredLogger,
  });
  base.clock.set(T);
  const app = base.app;
  const db = app.get(Sequelize);
  const storageControl = new StorageControl();
  const storage = app.get(ObjectStorage);
  const originalPut = storage.put.bind(storage);
  storage.put = storageControl.wrap(originalPut);

  const hooks: ExportKit['hooks'] = {};
  const enqueued: ExportKit['enqueued'] = [];
  const queue = app.get(TaskQueue);
  const enqueueSpy = jest
    .spyOn(queue, 'enqueue')
    .mockImplementation(async (name: string, body: unknown, opts?: unknown) => {
      enqueued.push({ queue: name, body, options: opts });
      await hooks.onEnqueue?.();
      return 'm-' + randomUUID();
    });

  const skuCalls: ExportKit['skuCalls'] = [];
  const products = app.get(ProductQueryService);
  const realLookup = products.getProductsByIds.bind(products);
  jest
    .spyOn(products, 'getProductsByIds')
    .mockImplementation(async (ids: string[], opts?: { shopId?: string }) => {
      skuCalls.push({ ids: ids.length, options: opts });
      await hooks.onLookup?.();
      return realLookup(ids, opts);
    });

  const lines = app.get<ExportLinesPort>(EXPORT_LINES, { strict: false });
  let read = 0;
  const realBatches = lines.batches.bind(lines);
  lines.batches = (...args) => {
    const inner = realBatches(...args)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => ({
        async next() {
          const result = await inner.next();
          if (!result.done) read += result.value.length;
          return result;
        },
        return: () =>
          inner.return?.() ?? Promise.resolve({ done: true, value: undefined }),
      }),
    };
  };

  const kit: ExportKit = {
    ...base,
    jobs: app.get<ExportJobsPort>(EXPORT_JOBS, { strict: false }),
    lines,
    run: app.get(OrderExportRunService, { strict: false }),
    maintenance: app.get(OrderExportMaintenanceService, { strict: false }),
    rt,
    storageControl,
    enqueued,
    skuCalls,
    hooks,
    linesRead: () => read,
    resetLinesRead: () => {
      read = 0;
    },
    async fileOf(exportId) {
      const job = await kit.jobs.findById(exportId);
      if (!job?.fileKey) throw new Error(`export ${exportId} has no file`);
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.getStream(job.fileKey))
        chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
    async forget(shopIds) {
      if (shopIds.length === 0) return;
      const ids = (
        await db.query<{ id: string }>(
          `SELECT "id" FROM "ExportJob" WHERE "shopId" IN (:shopIds)`,
          { type: QueryTypes.SELECT, replacements: { shopIds } },
        )
      ).map((r) => r.id);
      if (ids.length) {
        await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
          replacements: { ids },
        });
        await db.query(
          `DELETE FROM "ExportJobHistory" WHERE "exportId" IN (:ids)`,
          {
            replacements: { ids },
          },
        );
        await db.query(`DELETE FROM "ExportJob" WHERE "id" IN (:ids)`, {
          replacements: { ids },
        });
      }
    },
    async reset() {
      rt.reset();
      storageControl.reset();
      enqueued.length = 0;
      skuCalls.length = 0;
      delete hooks.onLookup;
      delete hooks.onEnqueue;
      read = 0;
      await base.reset();
      base.clock.set(T);
    },
    async close() {
      enqueueSpy.mockRestore();
      storage.put = originalPut;
      await base.close();
    },
  };
  return kit;
}

// ---------------------------------------------------------------- the standard fixture F5

export interface F5 {
  S: { id: string };
  S2: { id: string };
  /** Owner of S, staff of S, viewer of S, owner of S2, member of nothing. */
  U: TestUser;
  W: TestUser;
  V: TestUser;
  X: TestUser;
  N: TestUser;
  P1: string;
  P2: string;
  P3: string;
  /** order ids O1..O3 and shop order ids */
  O1: string;
  O2: string;
  O3: string;
  SO1: string;
  SO2: string;
  SO2b: string;
  SO3: string;
  /** line ids */
  L1: string;
  L2: string;
  L3: string;
  L4: string;
  L5: string;
  L6: string;
  /** Every shop id made, for `forget`. */
  shopIds: string[];
}

export interface LineSeed {
  id?: string;
  productId: string;
  title: string | null;
  quantity: number;
  unitPriceMinor: string | number;
  discountMinor?: string | number;
  lineTotalMinor?: string | number | null;
}

/** One order with one shop order per shop, written with explicit columns (test code may write every table, IX.6). */
export async function seedOrder(
  app: INestApplication,
  input: {
    buyerId: string;
    createdAt: Date;
    currency?: string;
    slices: Array<{
      shopId: string | null;
      status: 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';
      lines: LineSeed[];
      shopOrderId?: string;
    }>;
    orderId?: string;
  },
): Promise<{ orderId: string; shopOrderIds: string[]; lineIds: string[] }> {
  const db = app.get(Sequelize);
  const orderId = input.orderId ?? uuidv7();
  await db.query(
    `INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash", "version", "createdAt", "updatedAt")
     VALUES (:orderId, :buyerId, 'PAID', 0, :currency, :key, 'seed', 1, :at, :at)`,
    {
      replacements: {
        orderId,
        buyerId: input.buyerId,
        currency: input.currency ?? 'EUR',
        key: `seed-${orderId}`,
        at: input.createdAt,
      },
    },
  );
  const shopOrderIds: string[] = [];
  const lineIds: string[] = [];
  for (const slice of input.slices) {
    const shopOrderId = slice.shopOrderId ?? uuidv7();
    shopOrderIds.push(shopOrderId);
    if (slice.shopId)
      await db.query(
        `INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
         VALUES (:shopOrderId, :orderId, :shopId, 0, :status, :at, :at)`,
        {
          replacements: {
            shopOrderId,
            orderId,
            shopId: slice.shopId,
            status: slice.status,
            at: input.createdAt,
          },
        },
      );
    for (const line of slice.lines) {
      const lineId = line.id ?? uuidv7();
      lineIds.push(lineId);
      await db.query(
        `INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
         VALUES (:lineId, :orderId, :productId, :title, :quantity, :price, :discount, :total, :shopId, :at, :at)`,
        {
          replacements: {
            lineId,
            orderId,
            productId: line.productId,
            title: line.title,
            quantity: line.quantity,
            price: String(line.unitPriceMinor),
            discount: String(line.discountMinor ?? 0),
            total:
              line.lineTotalMinor === null
                ? null
                : String(
                    line.lineTotalMinor ??
                      BigInt(line.unitPriceMinor) * BigInt(line.quantity) -
                        BigInt(line.discountMinor ?? 0),
                  ),
            shopId: slice.shopId,
            at: input.createdAt,
          },
        },
      );
    }
  }
  return { orderId, shopOrderIds, lineIds };
}

/**
 * Many identical-looking lines at once (batch boundaries, backpressure, progress): `orders` orders of `perOrder` lines,
 * all shop orders created at `at` (a shared timestamp stresses the keyset tie-break). Straight SQL, no per-row round trip.
 */
export async function seedBulkLines(
  app: INestApplication,
  input: {
    shopId: string;
    productId: string;
    buyerId: string;
    orders: number;
    perOrder: number;
    at: Date;
  },
): Promise<number> {
  const db = app.get(Sequelize);
  await db.query(
    `WITH o AS (
       INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash", "version", "createdAt", "updatedAt")
       SELECT uuidv7(), :buyerId, 'PAID', 0, 'EUR', 'bulk-' || gen_random_uuid()::text, 'seed', 1, :at, :at
         FROM generate_series(1, :orders)
       RETURNING "id"),
     so AS (
       INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
       SELECT uuidv7(), o."id", :shopId, 0, 'PAID', :at, :at FROM o
       RETURNING "id", "bisOrderId")
     INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
     SELECT uuidv7(), so."bisOrderId", :productId, 'bulk-' || (row_number() OVER ())::text, 1, 1000, 0, 1000, :shopId, :at, :at
       FROM so, generate_series(1, :perOrder)`,
    {
      replacements: {
        shopId: input.shopId,
        productId: input.productId,
        buyerId: input.buyerId,
        orders: input.orders,
        perOrder: input.perOrder,
        at: input.at,
      },
    },
  );
  return input.orders * input.perOrder;
}

/** `F5`: shops S and S2, users U W V X N, products P1..P3 with SKUs, and the five lines of S (spec.md notation). */
export async function seedF5(kit: ExportKit): Promise<F5> {
  const app = kit.app;
  const [U, W, V, X, N, B] = await Promise.all([
    kit.newUser(),
    kit.newUser(),
    kit.newUser(),
    kit.newUser(),
    kit.newUser(),
    kit.newUser(),
  ]);
  const S = await createShop(app, U);
  const S2 = await createShop(app, X);
  await addMember(app, S.id, W.id, 'STAFF');
  await addMember(app, S.id, V.id, 'VIEWER');
  const p = async (shop: { id: string }, sku: string, title: string) =>
    (await createProduct(app, shop, { externalSku: sku, title })).id;
  const P1 = await p(S, 'SKU-P1', 'Cable, braided (catalog)');
  const P2 = await p(S, 'SKU-P2', 'Adapter');
  const P3 = await p(S2, 'SKU-P3', 'Other');
  const at = (days: number) => new Date(T.getTime() - days * DAY);

  const l = {
    L1: uuidv7(),
    L2: uuidv7(),
    L3: uuidv7(),
    L4: uuidv7(),
    L5: uuidv7(),
    L6: uuidv7(),
  };
  const ids = { O1: uuidv7(), O2: uuidv7(), O3: uuidv7() };
  const so = { SO1: uuidv7(), SO2: uuidv7(), SO2b: uuidv7(), SO3: uuidv7() };
  // Shop order ids are ordered like their orders so (time, id) order is the order of the spec.
  await seedOrder(app, {
    orderId: ids.O1,
    buyerId: B.id,
    createdAt: at(3),
    slices: [
      {
        shopId: S.id,
        shopOrderId: so.SO1,
        status: 'PAID',
        lines: [
          {
            id: l.L1,
            productId: P1,
            title: 'Cable, braided',
            quantity: 2,
            unitPriceMinor: 1000,
            discountMinor: 100,
            lineTotalMinor: 1900,
          },
          {
            id: l.L2,
            productId: P2,
            title: 'He said "hi"',
            quantity: 1,
            unitPriceMinor: 500,
            discountMinor: 0,
            lineTotalMinor: 500,
          },
        ],
      },
    ],
  });
  await seedOrder(app, {
    orderId: ids.O2,
    buyerId: B.id,
    createdAt: at(2),
    slices: [
      {
        shopId: S.id,
        shopOrderId: so.SO2,
        // SHIPPED is not a shop-order status (check constraint ShopOrder_status_check); REFUNDED stands in for it.
        status: 'REFUNDED',
        lines: [
          {
            id: l.L3,
            productId: P1,
            title: 'Cable, braided',
            quantity: 1,
            unitPriceMinor: 1000,
            lineTotalMinor: 1000,
          },
        ],
      },
      {
        shopId: S2.id,
        shopOrderId: so.SO2b,
        status: 'PAID',
        lines: [
          {
            id: l.L5,
            productId: P3,
            title: 'Other',
            quantity: 1,
            unitPriceMinor: 700,
            lineTotalMinor: 700,
          },
        ],
      },
    ],
  });
  await seedOrder(app, {
    orderId: ids.O3,
    buyerId: B.id,
    createdAt: at(1),
    slices: [
      {
        shopId: S.id,
        shopOrderId: so.SO3,
        status: 'CANCELLED',
        lines: [
          {
            id: l.L4,
            productId: P2,
            title: 'He said "hi"',
            quantity: 3,
            unitPriceMinor: 500,
            lineTotalMinor: 1500,
          },
          {
            id: l.L6,
            productId: P1,
            title: 'Cable, braided',
            quantity: 1,
            unitPriceMinor: 1000,
            lineTotalMinor: 1000,
          },
        ],
      },
    ],
  });
  return {
    S,
    S2,
    U,
    W,
    V,
    X,
    N,
    P1,
    P2,
    P3,
    ...ids,
    ...so,
    ...l,
    shopIds: [S.id, S2.id],
  };
}

/** The shop's members as the standard users: `U` owner, `W` staff (has `orders.manage`), `V` viewer (has not). */
export const startExport = (
  kit: ExportKit,
  user: TestUser,
  shopId: string,
  key: string = `key-${randomUUID()}`,
) =>
  kit
    .as(user)
    .post(`/api/shops/${shopId}/order-exports`)
    .set('Idempotency-Key', key)
    .send({});

/** Runs the queued export of a response the way the worker does, returning the outcome. */
export const runExport = (kit: ExportKit, exportId: string) =>
  kit.run.handle(exportId);

/** Polls until the condition holds (the run is in the state a spec wants to inspect); fails with the label otherwise. */
export async function waitFor(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Records of a CSV file without the BOM and the header. */
export const csvRows = (file: string): string[] =>
  file
    .slice(CSV_BOM.length)
    .split('\r\n')
    .filter((line) => line.length > 0)
    .slice(1);

export { outboxRowsFor };
