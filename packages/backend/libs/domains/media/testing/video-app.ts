import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import {
  DeliveryEdge,
  InMemoryDeliveryEdge,
  UnconfiguredDeliveryEdge,
} from '@app/infrastructure/delivery-edge';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import {
  TaskQueue,
  type EnqueueOptions,
  type TaskMessage,
} from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { S3ObjectStorage } from '@app/infrastructure/storage/s3-object-storage';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
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
import type { VideoStatus } from '../domain/video-status';
import {
  VideoLogger,
  VideoMetrics,
  VideoStore,
  type VideoLogFields,
  type VideoMetricName,
  type VideoOutputs,
} from '../domain/video-ports';
import { sourceKey } from '../domain/delivery-paths';
import { PART_SIZE } from '../domain/video-limits';
import { taskTimeoutMs } from '../domain/task-limits';
import {
  VIDEO_PART_SIZE,
  VIDEO_QUEUE,
  VIDEO_TASK_LIMITS,
  type TaskLimits,
} from '../video.constants';
import { VideoModule } from '../video.module';
import { VideoWorkerModule } from '../video-worker.module';
import { StubEncoder } from './stub-encoder';

/** The object store's smallest non-last part. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

export const MINIO = { host: 'localhost', port: 9210 };
export const REDIS = { host: 'localhost', port: 6400 };

/** A recording `VideoMetrics`: what was counted and observed, per name and label values. */
export class RecordingVideoMetrics extends VideoMetrics {
  readonly counts = new Map<string, number>();
  readonly observed: {
    name: string;
    value: number;
    labels: Record<string, string>;
  }[] = [];
  inc(name: VideoMetricName, labels: Record<string, string> = {}, by = 1) {
    const key = Object.keys(labels).length
      ? `${name}{${Object.values(labels).join(',')}}`
      : name;
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  observe(
    name: VideoMetricName,
    value: number,
    labels: Record<string, string> = {},
  ) {
    this.observed.push({ name, value, labels });
  }
  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

export class RecordingVideoLogger extends VideoLogger {
  readonly lines: { level: string; message: string; fields: VideoLogFields }[] =
    [];
  info(message: string, fields: VideoLogFields) {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields: VideoLogFields) {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields: VideoLogFields) {
    this.lines.push({ level: 'error', message, fields });
  }
}

/**
 * The `video-transcode` transport of the tests: records what the code enqueued (with its options), and delivers
 * messages to the registered consumer the way several workers would: all at once, twice, or later.
 */
export class VideoTestQueue extends InMemoryTaskQueue {
  private readonly consumers = new Map<
    string,
    (message: TaskMessage<unknown>) => Promise<void>
  >();

  override consume<T>(
    queue: string,
    handler: (msg: TaskMessage<T>) => Promise<void>,
    options?: Parameters<InMemoryTaskQueue['consume']>[2],
  ) {
    this.consumers.set(
      queue,
      handler as (message: TaskMessage<unknown>) => Promise<void>,
    );
    return super.consume(queue, handler, options);
  }

  /** Every message ever enqueued, with its options, in order (kept after delivery; `reset` clears it). */
  readonly log: { queue: string; body: unknown; options?: EnqueueOptions }[] =
    [];

  override enqueue<T>(queue: string, body: T, options?: EnqueueOptions) {
    const result = super.enqueue(queue, body, options);
    // Only what the queue accepted is logged: a rejected option set (a FIFO option on this queue) never gets here.
    void result.then(
      () => this.log.push({ queue, body, options }),
      () => undefined,
    );
    return result;
  }

  /** What was sent to `queue` and not yet delivered. */
  pending(queue = VIDEO_QUEUE) {
    return this.sent.filter((m) => m.queue === queue);
  }

  /** Takes the pending messages of `queue` off the list and returns them. */
  take(queue = VIDEO_QUEUE) {
    const taken = this.pending(queue);
    this.sent.splice(
      0,
      this.sent.length,
      ...this.sent.filter((m) => m.queue !== queue),
    );
    return taken;
  }

  /** Delivers one message to the consumer, as the queue would (`attributes` from the enqueue options). */
  async deliver(
    body: unknown,
    options: {
      receiveCount?: number;
      attributes?: Record<string, string>;
    } = {},
    queue = VIDEO_QUEUE,
  ): Promise<void> {
    const handler = this.consumers.get(queue);
    if (!handler) throw new Error(`no consumer registered for ${queue}`);
    await handler({
      id: randomUUID(),
      body,
      receiveCount: options.receiveCount ?? 1,
      attributes: options.attributes ?? {},
    });
  }

  /** One wave: every pending message delivered at the same moment on separate "workers". */
  async wave(queue = VIDEO_QUEUE): Promise<number> {
    const messages = this.take(queue);
    await Promise.all(
      messages.map((m) =>
        this.deliver(m.body, { attributes: m.options?.attributes }, queue),
      ),
    );
    return messages.length;
  }

  /** Waves until nothing is pending (bounded). Returns the bodies of every wave, in order. */
  async runAll(queue = VIDEO_QUEUE, maxWaves = 20): Promise<unknown[][]> {
    const waves: unknown[][] = [];
    for (let i = 0; i < maxWaves; i++) {
      const bodies = this.pending(queue).map((m) => m.body);
      if (bodies.length === 0) break;
      waves.push(bodies);
      await this.wave(queue);
    }
    return waves;
  }
}

export interface VideoWorld {
  owner: TestUser;
  staff: TestUser;
  viewer: TestUser;
  outsider: TestUser;
  otherOwner: TestUser;
  shop: { id: string };
  otherShop: { id: string };
}

export interface VideoSeed {
  id?: string;
  shopId: string;
  uploaderId: string;
  title?: string;
  visibility?: 'public' | 'unlisted';
  status?: VideoStatus;
  sizeBytes?: number;
  productId?: string | null;
  uploadId?: string | null;
  failureCode?: string | null;
  retryCount?: number;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  outputs?: VideoOutputs | null;
  shareToken?: string | null;
  objectsPurgedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  sessionExpiresAt?: Date;
  partSize?: number;
  version?: number;
}

export interface VideoTestApp extends CatalogTestApp {
  queue: VideoTestQueue;
  store: VideoStore;
  storage: ObjectStorage;
  edge: InMemoryDeliveryEdge | UnconfiguredDeliveryEdge;
  /** PEM public key matching the edge's throwaway key pair, to verify signatures. */
  publicKey: string;
  /** The throwaway private key (a log or body that contains any of it is a leak). */
  privateKey: string;
  metrics: RecordingVideoMetrics;
  logger: RecordingVideoLogger;
  /** Proxy in front of MinIO that the app's own storage goes through (only with `storageProxy`). */
  storageProxy: TcpFaultProxy | null;
  /** Proxy in front of Redis (only with `redisProxy`): `refuse` makes the rate limiter's store unreachable. */
  redisProxy: TcpFaultProxy | null;
  /** The part length the upload service uses; set `value` to `MIN_PART_SIZE` for real multi-part puts (reset restores 64 MiB). */
  partSize: { value: number };
  /** The task time limit the worker uses; assign `timeoutMs` to shorten it (reset restores the real one). */
  taskTimeout: TaskLimits;
  sql<T extends object = Record<string, unknown>>(
    text: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  world(): Promise<VideoWorld>;
  product(shopId: string, seed?: ProductSeed): Promise<SeededProduct>;
  /** Inserts a video row (and its first history row) straight into the tables; no object is created. */
  video(seed: VideoSeed): Promise<{ id: string; sourceKey: string }>;
  row(id: string): Promise<Record<string, any> | undefined>;
  history(id: string): Promise<
    {
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      failureCode: string | null;
    }[]
  >;
  tasks(id: string): Promise<Record<string, any>[]>;
  outbox(type?: string): Promise<
    {
      type: string;
      aggregateId: string;
      aggregateVersion: number;
      payload: Record<string, any>;
      envelope: Record<string, any>;
    }[]
  >;
  objectExists(key: string): Promise<boolean>;
  objectBytes(key: string): Promise<Buffer>;
  objectHeaders(
    key: string,
  ): Promise<{ contentType?: string; cacheControl?: string } | null>;
  faultProxy(target: { host: string; port: number }): Promise<TcpFaultProxy>;
  proxies: TcpFaultProxy[];
  /** Captured stdout of the structured logger (only with `structuredLogger`). */
  rawLogs(): string;
  /** The stub encoder (only with `worker`): `install()` puts it first on PATH, `uninstall()` restores the machine's. */
  encoder: StubEncoder | null;
  /**
   * A `PROCESSING` video whose source is already in storage and whose `probe` task is `QUEUED` with its message sent:
   * what `complete` leaves behind, without putting parts. `source` must be at least 1,024 bytes.
   */
  processingVideo(input: {
    shopId: string;
    uploaderId: string;
    source: Buffer;
    visibility?: 'public' | 'unlisted';
    productId?: string | null;
    id?: string;
    title?: string;
  }): Promise<{ id: string; sourceKey: string }>;
  /** Waves until no message is left; returns the task names of each wave, in order. */
  runWaves(): Promise<string[][]>;
  /** PUTs a part body to its presigned URL like a browser would; returns the response. */
  putPart(url: string, body: Buffer | Uint8Array): Promise<Response>;
  /** Starts an upload and puts every part (`bodyOf(length)` makes the bytes); returns the start answer and etags. */
  uploadParts(
    start: {
      parts: { partNumber: number; url: string; contentLength: number }[];
    },
    options?: {
      only?: number[];
      bodyOf?: (partNumber: number, length: number) => Buffer;
    },
  ): Promise<{ partNumber: number; etag: string }[]>;
}

export interface VideoAppOptions extends Pick<
  Parameters<typeof createCatalogApp>[0] & object,
  'extraImports'
> {
  /** Put a fault proxy between the app and MinIO (its own storage and the part URLs it signs go through it). */
  storageProxy?: boolean;
  redisProxy?: boolean;
  /** Also load `VideoWorkerModule`: the app consumes `video-transcode` and runs tasks on whatever `ffmpeg` is on PATH. */
  worker?: boolean;
  /** Run the production JSON logger and capture what it writes to stdout (`rawLogs()`). */
  structuredLogger?: boolean;
  /** `signing` (default): throwaway RSA key pair; `unconfigured`: no key (unlisted playback answers 503). */
  edge?: 'signing' | 'unconfigured';
  env?: Record<string, string>;
}

/** The real `VideoModule` behind the production HTTP pipeline, real Postgres, MinIO and Redis; only the queue transport is in memory. */
export async function createVideoApp(
  options: VideoAppOptions = {},
): Promise<VideoTestApp> {
  const queue = new VideoTestQueue();
  const proxies: TcpFaultProxy[] = [];
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start(REDIS)
    : null;
  if (redisProxy) proxies.push(redisProxy);
  const storageProxy = options.storageProxy
    ? await TcpFaultProxy.start(MINIO)
    : null;
  if (storageProxy) proxies.push(storageProxy);

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const edge =
    options.edge === 'unconfigured'
      ? new UnconfiguredDeliveryEdge()
      : new InMemoryDeliveryEdge({ keyPairId: 'KTESTKEYPAIR', privateKey });
  const metrics = new RecordingVideoMetrics();
  const logger = new RecordingVideoLogger();
  // Created with the worker, put on PATH only by the tests that want it (`encoder.install()`), so a spec can run the
  // same scenario on the machine's real ffmpeg when it is there.
  const encoder = options.worker ? await StubEncoder.create() : null;

  const partSize = { value: PART_SIZE };
  const taskTimeout: TaskLimits = { timeoutMs: taskTimeoutMs };
  const holder: { clock?: { nowMs(): number } } = {};
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const base = await createCatalogApp({
    structuredLogger: options.structuredLogger,
    ...(redisProxy && { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` }),
    ...(options.env && { env: options.env }),
    extraImports: [
      VideoModule,
      ...(options.worker ? [VideoWorkerModule] : []),
      ...(options.extraImports ?? []),
    ],
    customize: (builder) => {
      let b = builder
        .overrideProvider(TaskQueue)
        .useValue(queue)
        .overrideProvider(TimeSource)
        .useValue({ overrideMs: () => holder.clock?.nowMs() ?? null })
        .overrideProvider(DeliveryEdge)
        .useValue(edge)
        .overrideProvider(VideoMetrics)
        .useValue(metrics)
        .overrideProvider(VideoLogger)
        .useValue(logger)
        .overrideProvider(VIDEO_PART_SIZE)
        .useValue(partSize);
      if (options.worker)
        b = b.overrideProvider(VIDEO_TASK_LIMITS).useValue(taskTimeout);
      if (storageProxy)
        b = b.overrideProvider(ObjectStorage).useFactory({
          factory: (config: ApiConfigService) =>
            new S3ObjectStorage(viaConfig(config, storageProxy.port)),
          inject: [ApiConfigService],
        });
      return b;
    },
  });
  holder.clock = base.clock;
  const app: INestApplication = base.app;
  const sequelize = app.get(Sequelize);
  const store = app.get(VideoStore);
  const storage = app.get(ObjectStorage);
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

  const t: VideoTestApp = {
    ...base,
    queue,
    store,
    storage,
    edge,
    publicKey,
    privateKey,
    metrics,
    logger,
    storageProxy,
    redisProxy,
    partSize,
    taskTimeout,
    sql,
    proxies,
    async world() {
      const [owner, staff, viewer, outsider, otherOwner] = await Promise.all([
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
      ]);
      const shop = await createShop(app, owner, { name: 'Video Shop' });
      const otherShop = await createShop(app, otherOwner, {
        name: 'Other Video Shop',
      });
      await addMember(app, shop.id, staff.id, 'STAFF');
      await addMember(app, shop.id, viewer.id, 'VIEWER');
      return { owner, staff, viewer, outsider, otherOwner, shop, otherShop };
    },
    product: (shopId, seed = {}) => createProduct(app, { id: shopId }, seed),
    async video(seed) {
      const id = seed.id ?? uuidv7();
      const status = seed.status ?? 'UPLOADING';
      const visibility = seed.visibility ?? 'public';
      const createdAt = seed.createdAt ?? base.clock.now();
      const key = sourceKey(id);
      await sequelize.query(
        `INSERT INTO "Video" ("id","shopId","uploaderId","title","visibility","status","failureCode","retryCount","sourceKey","uploadId",
                              "sizeBytes","contentType","partSize","sessionExpiresAt","shareToken","productId","durationSec","width","height",
                              "outputs","objectsPurgedAt","version","createdAt","updatedAt")
         VALUES (:id,:shopId,:uploaderId,:title,:visibility,:status,:failureCode,:retryCount,:sourceKey,:uploadId,
                 :sizeBytes,'video/mp4',:partSize,:sessionExpiresAt,:shareToken,:productId,:durationSec,:width,:height,
                 :outputs::jsonb,:objectsPurgedAt,:version,:createdAt,:updatedAt)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            id,
            shopId: seed.shopId,
            uploaderId: seed.uploaderId,
            title: seed.title ?? 'A video',
            visibility,
            status,
            failureCode: seed.failureCode ?? null,
            retryCount: seed.retryCount ?? 0,
            sourceKey: key,
            uploadId:
              seed.uploadId === undefined
                ? status === 'UPLOADING'
                  ? `upload-${id}`
                  : null
                : seed.uploadId,
            sizeBytes: seed.sizeBytes ?? 1_000_000,
            partSize: seed.partSize ?? 64 * 1024 * 1024,
            sessionExpiresAt:
              seed.sessionExpiresAt ??
              new Date(createdAt.getTime() + 24 * 3_600_000),
            shareToken:
              seed.shareToken === undefined
                ? visibility === 'unlisted'
                  ? `${id.replace(/-/g, '')}${'a'.repeat(11)}`
                  : null
                : seed.shareToken,
            productId: seed.productId ?? null,
            durationSec: seed.durationSec ?? null,
            width: seed.width ?? null,
            height: seed.height ?? null,
            outputs: seed.outputs ? JSON.stringify(seed.outputs) : null,
            objectsPurgedAt: seed.objectsPurgedAt ?? null,
            version: seed.version ?? 1,
            createdAt,
            updatedAt: seed.updatedAt ?? createdAt,
          },
        },
      );
      await sequelize.query(
        `INSERT INTO "VideoStatusHistory" ("videoId","fromStatus","toStatus","actorType","actorId","createdAt") VALUES (:id, NULL, :status, 'user', :uploaderId, :createdAt)`,
        {
          replacements: {
            id,
            status,
            uploaderId: seed.uploaderId,
            createdAt,
          },
        },
      );
      return { id, sourceKey: key };
    },
    async row(id) {
      return (
        await sql<Record<string, any>>(
          `SELECT * FROM "Video" WHERE "id" = :id`,
          {
            id,
          },
        )
      )[0];
    },
    history: (id) =>
      sql(
        `SELECT "fromStatus","toStatus","actorType","failureCode" FROM "VideoStatusHistory" WHERE "videoId" = :id ORDER BY "createdAt","id"`,
        { id },
      ),
    tasks: (id) =>
      sql(
        `SELECT * FROM "VideoTask" WHERE "videoId" = :id ORDER BY "createdAt","name"`,
        { id },
      ),
    async outbox(type) {
      const rows = await sql<{ payload: Record<string, any> }>(
        `SELECT "payload" FROM "Outbox" WHERE "topic" = 'media.events' ORDER BY "createdAt","id"`,
      );
      return rows
        .map((r) => r.payload)
        .filter((e) => (type ? e.type === type : e.type?.startsWith('video.')))
        .map((e) => ({
          type: e.type,
          aggregateId: e.aggregateId,
          aggregateVersion: e.aggregateVersion,
          payload: e.payload,
          envelope: e,
        }));
    },
    async objectExists(key) {
      return (await storage.head(key)) !== null;
    },
    async objectBytes(key) {
      const chunks: Buffer[] = [];
      for await (const chunk of (await storage.getStream(
        key,
      )) as AsyncIterable<Buffer>)
        chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
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
    async faultProxy(target) {
      const proxy = await TcpFaultProxy.start(target);
      proxies.push(proxy);
      return proxy;
    },
    encoder,
    rawLogs: () => logChunks.join(''),
    async processingVideo(input) {
      const id = input.id ?? uuidv7();
      const key = sourceKey(id);
      await storage.put(key, input.source, 'video/mp4');
      await t.video({
        id,
        shopId: input.shopId,
        uploaderId: input.uploaderId,
        status: 'PROCESSING',
        visibility: input.visibility,
        title: input.title,
        sizeBytes: input.source.length,
        productId: input.productId,
        uploadId: null,
      });
      await sequelize.query(
        `INSERT INTO "VideoTask" ("videoId","name","dependsOn","status","createdAt","updatedAt")
         VALUES (:id,'probe','{}','QUEUED',:now,:now)`,
        { replacements: { id, now: base.clock.now() } },
      );
      await queue.enqueue(VIDEO_QUEUE, { videoId: id, task: 'probe' });
      return { id, sourceKey: key };
    },
    async runWaves() {
      const waves = await queue.runAll();
      return waves.map((wave) => wave.map((b) => (b as { task: string }).task));
    },
    putPart(url, body) {
      return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
    },
    async uploadParts(start, opts = {}) {
      const out: { partNumber: number; etag: string }[] = [];
      for (const part of start.parts) {
        if (opts.only && !opts.only.includes(part.partNumber)) continue;
        const body = opts.bodyOf
          ? opts.bodyOf(part.partNumber, part.contentLength)
          : Buffer.alloc(part.contentLength, part.partNumber);
        const res = await t.putPart(part.url, body);
        if (!res.ok)
          throw new Error(`part ${part.partNumber} refused: ${res.status}`);
        out.push({
          partNumber: part.partNumber,
          etag: res.headers.get('etag') ?? '',
        });
      }
      return out;
    },
    async reset() {
      for (const proxy of proxies) {
        proxy.mode = 'pass';
        proxy.delayMs = 0;
      }
      partSize.value = PART_SIZE;
      taskTimeout.timeoutMs = taskTimeoutMs;
      queue.log.length = 0;
      queue.sent.length = 0;
      queue.deadLettered.length = 0;
      metrics.counts.clear();
      metrics.observed.length = 0;
      logger.lines.length = 0;
      await encoder?.reset();
      if (edge instanceof InMemoryDeliveryEdge) {
        edge.signed.length = 0;
        edge.invalidations.length = 0;
        edge.failInvalidations(undefined);
        edge.failSigning(undefined);
      }
      await base.reset();
    },
    async close() {
      for (const proxy of proxies) await proxy.close();
      await base.close();
      await encoder?.dispose();
      stdoutSpy?.mockRestore();
    },
  };
  return t;
}

/** A config view that points the S3 client at a proxy instead of MinIO (same bucket and credentials). */
function viaConfig(config: ApiConfigService, port: number): ApiConfigService {
  return {
    get: (key: string) =>
      key === 's3_endpoint'
        ? `http://127.0.0.1:${port}`
        : config.get(key as never),
  } as unknown as ApiConfigService;
}
