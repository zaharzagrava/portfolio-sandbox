import { randomUUID } from 'node:crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import type { MediaPurpose } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { FakeMalwareScanner } from '@app/infrastructure/antivirus/fake-scanner';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { S3ObjectStorage } from '@app/infrastructure/storage/s3-object-storage';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { MediaStatus } from '../domain/media-status';
import type { Variants } from '../domain/media-urls';
import type {
  MediaMetricName,
  MediaMetrics,
  MediaLogger,
  MediaLogFields,
} from '../domain/ports';
import { MediaStore } from '../domain/ports';
import { StorageBlobs } from '../infra/media-blobs';
import {
  createMediaProcessor,
  type MediaProcessorDeps,
  type ProcessorLimits,
} from '../infra/media-processor';
import { MediaModule } from '../media.module';

/** A recording `MediaMetrics`: what the processor counted and observed, per name. */
export class RecordingMetrics implements MediaMetrics {
  readonly counts = new Map<string, number>();
  readonly observed: {
    name: string;
    value: number;
    labels: Record<string, string>;
  }[] = [];
  inc(
    name: MediaMetricName,
    labels: Record<string, string> = {},
    by = 1,
  ): void {
    const key = Object.keys(labels).length
      ? `${name}{${Object.values(labels).join(',')}}`
      : name;
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  observe(
    name: MediaMetricName,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.observed.push({ name, value, labels });
  }
  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

export class RecordingLogger implements MediaLogger {
  readonly lines: { level: string; message: string; fields: MediaLogFields }[] =
    [];
  info(message: string, fields: MediaLogFields) {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields: MediaLogFields) {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields: MediaLogFields) {
    this.lines.push({ level: 'error', message, fields });
  }
}

export interface MediaWorld {
  owner: TestUser;
  staff: TestUser;
  viewer: TestUser;
  buyer: TestUser;
  otherOwner: TestUser;
  shop: { id: string };
  otherShop: { id: string };
}

export interface PhotoSeed {
  id?: string;
  shopId?: string | null;
  uploaderId: string;
  purpose?: MediaPurpose;
  status?: MediaStatus;
  variants?: Variants | null;
  width?: number | null;
  height?: number | null;
  rejectCode?: string | null;
  attempts?: number;
  leaseUntil?: Date | null;
  uploadedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  version?: number;
  originalKey?: string;
}

export interface MediaTestApp extends CatalogTestApp {
  queue: InMemoryTaskQueue;
  scanner: FakeMalwareScanner;
  metrics: RecordingMetrics;
  logger: RecordingLogger;
  store: MediaStore;
  storage: ObjectStorage;
  sql<T extends object = Record<string, unknown>>(
    text: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  /** A processor wired like `apps/lambdas`: the app's database and bucket, the fake scanner, the frozen clock. */
  processor(
    overrides?: Partial<MediaProcessorDeps> & {
      limits?: Partial<ProcessorLimits>;
    },
  ): ReturnType<typeof createMediaProcessor>;
  /** An object store pointing at `endpoint` instead of MinIO (a fault proxy), same bucket and credentials. */
  storageVia(endpoint: string): ObjectStorage;
  world(): Promise<MediaWorld>;
  product(shopId: string, seed?: ProductSeed): Promise<SeededProduct>;
  /** Inserts a photo row (and its first history row) straight into the table; no object is created. */
  photo(seed: PhotoSeed): Promise<{ id: string; originalKey: string }>;
  /** A `READY` product photo with variants (as the worker would have written them), without storage objects. */
  readyPhoto(
    shopId: string,
    uploaderId: string,
    seed?: Partial<PhotoSeed>,
  ): Promise<{ id: string; originalKey: string }>;
  putOriginal(key: string, body: Buffer, contentType?: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  /** Headers MinIO stores for an object (content type, cache control), or null. */
  objectHeaders(
    key: string,
  ): Promise<{ contentType?: string; cacheControl?: string } | null>;
  objectBytes(key: string): Promise<Buffer>;
  /** Keys under `media/derived/` right now. */
  derivedKeys(): Promise<string[]>;
  row(id: string): Promise<Record<string, any> | undefined>;
  history(id: string): Promise<
    {
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      rejectCode: string | null;
    }[]
  >;
  outbox(type?: string): Promise<
    {
      type: string;
      aggregateId: string;
      aggregateVersion: number;
      payload: Record<string, any>;
      envelope: Record<string, any>;
    }[]
  >;
  faultProxy(target: { host: string; port: number }): Promise<TcpFaultProxy>;
  proxies: TcpFaultProxy[];
}

export const MINIO = { host: 'localhost', port: 9210 };
export const REDIS = {
  host: 'localhost',
  port: Number(
    new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').port || 6400,
  ),
};

/** The real `MediaModule` behind the production HTTP pipeline, real Postgres, MinIO and Redis; only the queue transport is in memory. */
export async function createMediaApp(
  options: Parameters<typeof createCatalogApp>[0] & {
    redisProxy?: boolean;
  } = {},
): Promise<MediaTestApp> {
  const queue = new InMemoryTaskQueue();
  const proxies: TcpFaultProxy[] = [];
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start(REDIS)
    : null;
  if (redisProxy) proxies.push(redisProxy);
  // The limiter reads the app's frozen clock, so a spec fills a bucket without it refilling while the loop runs.
  const holder: { clock?: { nowMs(): number } } = {};
  const base = await createCatalogApp({
    ...options,
    ...(redisProxy && {
      redisUrl: `redis://127.0.0.1:${redisProxy.port}/${new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').pathname.slice(1) || '0'}`,
    }),
    extraImports: [MediaModule, ...(options.extraImports ?? [])],
    customize: (builder) => {
      const b = builder
        .overrideProvider(TaskQueue)
        .useValue(queue)
        .overrideProvider(TimeSource)
        .useValue({ overrideMs: () => holder.clock?.nowMs() ?? null });
      return options.customize ? options.customize(b) : b;
    },
  });
  holder.clock = base.clock;
  const app: INestApplication = base.app;
  const sequelize = app.get(Sequelize);
  const store = app.get(MediaStore);
  const storage = app.get(ObjectStorage);
  const scanner = new FakeMalwareScanner();
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const config = app.get(ApiConfigService);
  const rawS3 = new S3Client({
    region: 'eu-central-1',
    endpoint: config.get('s3_endpoint'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: (config.get('s3_access_key_id') ??
        config.get('aws_access_key_id')) as string,
      secretAccessKey: (config.get('s3_secret_access_key') ??
        config.get('aws_secret_access_key')) as string,
    },
  });

  const sql = <T extends object = Record<string, unknown>>(
    text: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(text, { type: QueryTypes.SELECT, replacements });

  const t: MediaTestApp = {
    ...base,
    queue,
    scanner,
    metrics,
    logger,
    store,
    storage,
    sql,
    proxies,
    processor(overrides = {}) {
      const { limits, ...rest } = overrides;
      return createMediaProcessor({
        tx: store.tx,
        blobs: new StorageBlobs(storage),
        scanner,
        clock: base.clock,
        metrics,
        logger,
        limits,
        ...rest,
      });
    },
    storageVia(endpoint) {
      const via = {
        get: (key: string) =>
          key === 's3_endpoint' ? endpoint : config.get(key as never),
      };
      return new S3ObjectStorage(via as unknown as ApiConfigService);
    },
    async world() {
      const [owner, staff, viewer, buyer, otherOwner] = await Promise.all([
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
      ]);
      const shop = await createShop(app, owner, { name: 'Photo Shop' });
      const otherShop = await createShop(app, otherOwner, {
        name: 'Other Shop',
      });
      await addMember(app, shop.id, staff.id, 'STAFF');
      await addMember(app, shop.id, viewer.id, 'VIEWER');
      return { owner, staff, viewer, buyer, otherOwner, shop, otherShop };
    },
    product: (shopId, seed = {}) => createProduct(app, { id: shopId }, seed),
    async photo(seed) {
      const id = seed.id ?? uuidv7();
      const purpose = seed.purpose ?? (seed.shopId ? 'product' : 'review');
      const shopId = seed.shopId === undefined ? null : seed.shopId;
      const originalKey =
        seed.originalKey ??
        `media/originals/${shopId ? `shops/${shopId}` : `users/${seed.uploaderId}`}/${randomUUID()}`;
      const status = seed.status ?? 'PENDING_UPLOAD';
      const createdAt = seed.createdAt ?? base.clock.now();
      await sequelize.query(
        `INSERT INTO "Media" ("id","shopId","uploaderId","purpose","status","originalKey","variants","width","height","rejectCode","attempts","leaseUntil","uploadedAt","version","createdAt","updatedAt")
         VALUES (:id,:shopId,:uploaderId,:purpose,:status,:originalKey,:variants::jsonb,:width,:height,:rejectCode,:attempts,:leaseUntil,:uploadedAt,:version,:createdAt,:updatedAt)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            id,
            shopId,
            uploaderId: seed.uploaderId,
            purpose,
            status,
            originalKey,
            variants: seed.variants ? JSON.stringify(seed.variants) : null,
            width: seed.width ?? null,
            height: seed.height ?? null,
            rejectCode: seed.rejectCode ?? null,
            attempts: seed.attempts ?? 0,
            leaseUntil: seed.leaseUntil ?? null,
            uploadedAt: seed.uploadedAt ?? null,
            version: seed.version ?? 1,
            createdAt,
            updatedAt: seed.updatedAt ?? createdAt,
          },
        },
      );
      await sequelize.query(
        `INSERT INTO "MediaStatusHistory" ("mediaId","fromStatus","toStatus","actorType","actorId","createdAt") VALUES (:id, NULL, :status, 'user', :uploaderId, :createdAt)`,
        {
          replacements: { id, status, uploaderId: seed.uploaderId, createdAt },
        },
      );
      return { id, originalKey };
    },
    async readyPhoto(shopId, uploaderId, seed = {}) {
      const id = seed.id ?? uuidv7();
      const variants = Object.fromEntries(
        (['thumb', 'feed', 'full'] as const).map((name) => [
          name,
          {
            key: `media/derived/${id.replace(/-/g, '')}-${name}.webp`,
            width: 200,
            height: 150,
          },
        ]),
      ) as Variants;
      return t.photo({
        id,
        shopId,
        uploaderId,
        status: 'READY',
        variants,
        width: 1600,
        height: 1200,
        ...seed,
      });
    },
    async putOriginal(key, body, contentType = 'image/jpeg') {
      await storage.put(key, body, contentType);
    },
    async objectExists(key) {
      return (await storage.head(key)) !== null;
    },
    async objectHeaders(key) {
      try {
        const out = await rawS3.send(
          new HeadObjectCommand({
            Bucket: config.get('media_bucket') ?? 'marketplace-media',
            Key: key,
          }),
        );
        return { contentType: out.ContentType, cacheControl: out.CacheControl };
      } catch (error) {
        if ((error as { name?: string }).name === 'NotFound') return null;
        throw error;
      }
    },
    async objectBytes(key) {
      const stream = await storage.getStream(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>)
        chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    async derivedKeys() {
      return (await storage.list('media/derived/')).map((o) => o.key).sort();
    },
    async row(id) {
      return (
        await sql<Record<string, any>>(
          `SELECT * FROM "Media" WHERE "id" = :id`,
          { id },
        )
      )[0];
    },
    history: (id) =>
      sql(
        `SELECT "fromStatus","toStatus","actorType","rejectCode" FROM "MediaStatusHistory" WHERE "mediaId" = :id ORDER BY "createdAt","id"`,
        { id },
      ),
    async outbox(type) {
      const rows = await sql<{ payload: Record<string, any> }>(
        `SELECT "payload" FROM "Outbox" WHERE "topic" = 'media.events' ORDER BY "createdAt","id"`,
      );
      return rows
        .map((r) => r.payload)
        .filter((e) => !type || e.type === type)
        .map((e) => ({
          type: e.type,
          aggregateId: e.aggregateId,
          aggregateVersion: e.aggregateVersion,
          payload: e.payload,
          envelope: e,
        }));
    },
    async faultProxy(target) {
      const proxy = await TcpFaultProxy.start(target);
      proxies.push(proxy);
      return proxy;
    },
    async reset() {
      for (const proxy of proxies) {
        proxy.mode = 'pass';
        proxy.delayMs = 0;
      }
      queue.sent.length = 0;
      queue.deadLettered.length = 0;
      metrics.counts.clear();
      metrics.observed.length = 0;
      logger.lines.length = 0;
      scanner.mode = 'clean';
      scanner.scans = 0;
      await base.reset();
    },
    async close() {
      for (const proxy of proxies) await proxy.close();
      await base.close();
    },
  };
  return t;
}
