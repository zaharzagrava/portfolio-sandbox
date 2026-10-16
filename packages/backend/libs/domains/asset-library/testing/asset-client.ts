import { Module, type INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { createHash, randomBytes } from 'node:crypto';
import nodeHttp from 'node:http';
import supertest from 'supertest';
import { v4 } from 'uuid';
import type { z } from 'zod';
import { Logger as PinoLogger } from 'nestjs-pino';
import { LoggingModule } from '@app/common/logging/logging.module';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { createUser } from '@app/test/utils/user-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { issueSession } from '@app/test/seeds/session.fixture';
import { Role } from '@app/domains/identity';
import { outboxRowsFor } from '@app/common/testing';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { chunk, type Chunk, type ChunkingParams } from '../domain/fastcdc';
import { ChunkStore } from '../domain/ports';
import { ASSET_DEFAULTS, type AssetConfig } from '../domain/asset-config';
import { ASSET_CONFIG } from '../application/asset-config.token';
import {
  AssetsModule,
  AssetsProjectorModule,
  AssetsWorkerModule,
} from '../assets.module';
import { chunkKey } from '../infra/chunk-store';
import { AssetCatalogShopConsumer } from '../infra/catalog-shop.consumer';
import { AssetOrdersConsumer } from '../infra/orders.consumer';
import { TestChunkStore } from './test-chunk-store';
import { deliver, paidEvent, paidPayload } from './events';

/** Chunking parameters of the specs (spec "User Scenarios": test parameters are 4 KiB / 16 KiB / 64 KiB). */
export const TEST_CHUNKING: ChunkingParams = {
  min: 4 * 1024,
  avg: 16 * 1024,
  max: 64 * 1024,
};

/** The separate origin share and buyer URLs are built on in the specs (different from `backend_host`). */
export const USERCONTENT_ORIGIN = 'http://usercontent.localhost:8401';

/** What the realtime hub fake saw; `mode` forces the hub down (AS-33). */
export class RecordingHub {
  events: { topic: string; type: string; data: unknown }[] = [];
  mode: 'ok' | 'down' | 'throws' = 'ok';

  publish(topic: string, type: string, data: unknown) {
    if (this.mode === 'throws') throw new Error('hub unreachable');
    if (this.mode === 'down')
      return Promise.resolve({ published: false, id: null });
    this.events.push({ topic, type, data });
    return Promise.resolve({ published: true, id: String(this.events.length) });
  }

  of(shopId: string) {
    return this.events.filter((e) => e.topic === `shop:${shopId}:assets`);
  }
}

@Module({
  imports: [AssetsModule, AssetsWorkerModule, AssetsProjectorModule],
  // the projection framework builds these in the projector app; the specs deliver to the same classes
  providers: [AssetOrdersConsumer, AssetCatalogShopConsumer],
})
class SpecModule {}

/** Parses a response body with its contracts schema (VII.6): fails with the issue list, never the values. */
export function expectContract<S extends z.ZodType>(
  schema: S,
  body: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      `response does not match its contract: ${JSON.stringify(
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        })),
      )}`,
    );
  return parsed.data;
}

export interface Actor {
  id: string;
  auth: Record<string, string>;
  sessionId: string;
}
export interface Seller extends Actor {
  shopId: string;
}

export interface SavedFile {
  chunks: Chunk[];
  bytes: Buffer;
  prepare: supertest.Response;
  commit: supertest.Response;
}

export interface AssetTestApp {
  app: INestApplication;
  clock: FakeClock;
  db: Sequelize;
  storage: ObjectStorage;
  hub: RecordingHub;
  store: TestChunkStore;
  config: AssetConfig;
  http: () => ReturnType<typeof supertest>;
  /** Moves the clock and re-issues every actor's access token (they expire on the clock's time). */
  advance(ms: number): Promise<void>;
  /** Sets the clock to a date and re-issues every actor's access token. */
  setTime(date: Date): Promise<void>;
  user(role?: Role): Promise<Actor>;
  /** A shop whose OWNER is the returned user. */
  seller(): Promise<Seller>;
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<Actor>;
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  outbox(aggregateId: string): ReturnType<typeof outboxRowsFor>;
  /** Everything written to stdout since the app started (only with `captureLogs`). */
  logLines(): string;
  close(): Promise<void>;
  // --- the sync client ---
  chunksOf(bytes: Buffer): Chunk[];
  prepare(s: Seller, chunks: { hash: string; size: number }[]): supertest.Test;
  /** PUTs the bytes of every chunk the prepare answer listed as missing, to the issued permission. */
  putMissing(
    res: supertest.Response,
    bytes: Buffer,
    chunks: Chunk[],
  ): Promise<void>;
  commit(
    s: Seller,
    body: Record<string, unknown>,
    key?: string,
  ): supertest.Test;
  /** Commits a zero-byte file: no chunks to prepare, the cheapest way to make an asset. */
  commitEmpty(
    s: Seller,
    path: string,
    options?: { baseVersion?: number; deviceId?: string },
  ): supertest.Test;
  /** Chunk, prepare, upload what is missing, commit. */
  save(
    s: Seller,
    path: string,
    bytes: Buffer,
    options?: { baseVersion?: number; deviceId?: string; key?: string },
  ): Promise<SavedFile>;
  /** Reads a version back through the manifest, every URL, in order. */
  download(s: Seller, assetId: string, version?: number): Promise<Buffer>;
  randomBytes(n: number): Buffer;
  orders: AssetOrdersConsumer;
  shopEvents: AssetCatalogShopConsumer;
  /**
   * A chunk row and its object as an old upload left them (4,000 bytes): `ageMs` since it was last unreferenced.
   * Written directly, so a spec can age data without waiting.
   */
  plant(
    s: Seller,
    ageMs: number,
    options?: { refCount?: number; protectedUntil?: Date | null },
  ): Promise<{ bytes: Buffer; hash: string }>;
  /** A product of the shop, seeded through the catalog's fixture (never through this domain). */
  product(s: Seller, title?: string): Promise<{ id: string }>;
  /** Links a product to an asset through the HTTP route. */
  link(s: Seller, productId: string, assetId: string): supertest.Test;
  /**
   * A buyer who holds an entitlement for `productId`: delivers a contract-valid `order.paid` for a line of the seller's
   * shop. Returns the order ID.
   */
  buy(
    s: Seller,
    buyer: Actor,
    productId: string,
    title?: string,
  ): Promise<string>;
  /**
   * A raw GET that reports an aborted body instead of throwing. With `forwardedFor` the request comes from the trusted
   * proxy address (127.0.0.2) carrying that client address, so a spec can speak for "another address".
   */
  rawGet(
    pathname: string,
    options?: { forwardedFor?: string },
  ): Promise<RawResponse>;
  rawPost(
    pathname: string,
    options?: { forwardedFor?: string },
  ): Promise<RawResponse>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** False when the connection was cut before the declared length arrived. */
  complete: boolean;
}

export interface AssetAppOptions {
  config?: Partial<AssetConfig>;
  /** Installs the structured logger and captures everything written to stdout (`logLines()`). */
  captureLogs?: boolean;
}

/**
 * The real asset modules over real Postgres, Redis, outbox and MinIO, with the production global pipe, filter and
 * prefix. Only the edges are replaced: the clock, the realtime hub's transport (recording, with a failure switch) and
 * the chunk store gets fault hooks over the real storage.
 */
export async function createAssetApp(
  options: AssetAppOptions = {},
): Promise<AssetTestApp> {
  const clock = new FakeClock(new Date());
  const logs: string[] = [];
  const writeSpy = options.captureLogs
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logs.push(String(chunk));
          return true;
        })
    : null;
  const hub = new RecordingHub();
  const config: AssetConfig = { ...ASSET_DEFAULTS, ...options.config };
  let shared: TestChunkStore | undefined;
  const moduleRef = await generateTestingModule(
    options.captureLogs
      ? [SpecModule, SeedsModule, LoggingModule]
      : [SpecModule, SeedsModule],
    {
      stores: ['redis', 'storage'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(RealtimePublisher)
          .useValue(hub)
          .overrideProvider(ChunkStore)
          // one instance for every module that provides the token, so the fault hooks reach the code under test
          .useFactory({
            factory: (storage: ObjectStorage) =>
              (shared ??= new TestChunkStore(storage)),
            inject: [ObjectStorage],
          })
          .overrideProvider(ASSET_CONFIG)
          .useValue(config),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  const settings = app.get(ApiConfigService) as MockApiConfigService;
  // read at bootstrap: the proxy address a spec speaks through (`rawGet`), and the separate user-content origin
  settings.set('trusted_proxies', '127.0.0.2');
  settings.set('usercontent_origin', USERCONTENT_ORIGIN);
  configureHttpApp(app, {
    useStructuredLogger: options.captureLogs === true,
    processHandlers: false,
  });
  await app.listen(0, '127.0.0.1');
  if (options.captureLogs) app.useLogger(app.get(PinoLogger));

  const db: Sequelize = app.get(getConnectionToken());
  const http = () => supertest(app.getHttpServer());
  const storage = app.get(ObjectStorage);
  const store = app.get(ChunkStore) as TestChunkStore;

  const actors: { actor: Actor; role: Role }[] = [];
  const user: AssetTestApp['user'] = async (role = Role.USER) => {
    const created = await createUser(app, {
      email: `a-${v4()}@mail.com`,
      role,
    });
    const { bearer, sessionId } = await issueSession(app, created);
    const actor = {
      id: created.id,
      auth: { Authorization: bearer },
      sessionId,
    };
    actors.push({ actor, role });
    return actor;
  };
  /** Moves the clock and signs the actors in again: an access token lives 300 s of the clock's time. */
  const advance: AssetTestApp['advance'] = async (ms) => {
    clock.advance(ms);
    await resign();
  };
  const setTime: AssetTestApp['setTime'] = async (date) => {
    clock.set(date);
    await resign();
  };
  const resign = async () => {
    for (const { actor, role } of actors) {
      const session = await issueSession(app, { id: actor.id, role });
      actor.auth.Authorization = session.bearer;
      actor.sessionId = session.sessionId;
    }
  };
  const seller: AssetTestApp['seller'] = async () => {
    const owner = await user();
    const shop = await createShop(app, owner, { name: 'Asset Shop' });
    return { ...owner, shopId: shop.id as string };
  };
  const member: AssetTestApp['member'] = async (shopId, role) => {
    const created = await user();
    await addMember(app, shopId, created.id, role);
    return created;
  };
  const rows: AssetTestApp['rows'] = (sql, replacements = {}) =>
    db.query(sql, { type: QueryTypes.SELECT, replacements }) as Promise<never>;

  const chunksOf = (bytes: Buffer) => chunk(bytes, TEST_CHUNKING);
  const prepare: AssetTestApp['prepare'] = (s, chunks) =>
    http()
      .post(`/api/shops/${s.shopId}/assets/prepare`)
      .set(s.auth)
      .send({ chunks });
  const commit: AssetTestApp['commit'] = (s, body, key = `k-${v4()}`) =>
    http()
      .post(`/api/shops/${s.shopId}/assets/commit`)
      .set(s.auth)
      .set('Idempotency-Key', key)
      .send(body);

  const commitEmpty: AssetTestApp['commitEmpty'] = (s, path, opts = {}) =>
    commit(s, {
      path,
      baseVersion: opts.baseVersion ?? 0,
      chunks: [],
      sizeBytes: 0,
      deviceId: opts.deviceId ?? 'laptop-1',
    });

  const putMissing: AssetTestApp['putMissing'] = async (res, bytes, chunks) => {
    const byHash = new Map(chunks.map((c) => [c.hash, c]));
    for (const m of res.body.missing as {
      hash: string;
      url: string;
      headers: Record<string, string>;
    }[]) {
      const c = byHash.get(m.hash)!;
      const { 'content-length': _length, ...headers } = m.headers;
      const put = await fetch(m.url, {
        method: 'PUT',
        headers,
        body: bytes.subarray(
          c.offset,
          c.offset + c.length,
        ) as unknown as BodyInit,
      });
      if (!put.ok) throw new Error(`storage refused the upload: ${put.status}`);
    }
  };

  const save: AssetTestApp['save'] = async (s, path, bytes, opts = {}) => {
    const chunks = chunksOf(bytes);
    const prep = await prepare(
      s,
      chunks.map((c) => ({ hash: c.hash, size: c.length })),
    );
    if (prep.status !== 200)
      throw new Error(
        `prepare answered ${prep.status}: ${JSON.stringify(prep.body)}`,
      );
    await putMissing(prep, bytes, chunks);
    const res = await commit(
      s,
      {
        path,
        baseVersion: opts.baseVersion ?? 0,
        chunks: chunks.map((c) => c.hash),
        sizeBytes: bytes.length,
        deviceId: opts.deviceId ?? 'laptop-1',
      },
      opts.key,
    );
    return { chunks, bytes, prepare: prep, commit: res };
  };

  const download: AssetTestApp['download'] = async (s, assetId, version) => {
    const parts: Buffer[] = [];
    let from = 0;
    for (;;) {
      const res = await http()
        .get(`/api/shops/${s.shopId}/assets/${assetId}/manifest`)
        .query({ from, limit: 2000, ...(version ? { version } : {}) })
        .set(s.auth);
      if (res.status !== 200)
        throw new Error(
          `manifest answered ${res.status}: ${JSON.stringify(res.body)}`,
        );
      for (const c of res.body.chunks as { url: string }[]) {
        const got = await fetch(c.url);
        if (!got.ok) throw new Error(`chunk download answered ${got.status}`);
        parts.push(Buffer.from(await got.arrayBuffer()));
      }
      if (res.body.nextFrom === null) break;
      from = res.body.nextFrom as number;
    }
    return Buffer.concat(parts);
  };

  const raw = (
    method: 'GET' | 'POST',
    pathname: string,
    options: { forwardedFor?: string } = {},
  ) =>
    new Promise<RawResponse>((resolve, reject) => {
      const { port } = app.getHttpServer().address() as { port: number };
      const req = nodeHttp.request(
        {
          host: '127.0.0.1',
          port,
          path: pathname,
          method,
          ...(options.forwardedFor
            ? {
                localAddress: '127.0.0.2',
                headers: { 'x-forwarded-for': options.forwardedFor },
              }
            : {}),
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (piece: Buffer) => parts.push(piece));
          const done = () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(parts),
              complete: res.complete,
            });
          res.on('end', done);
          res.on('close', done);
          res.on('error', done);
        },
      );
      req.on('error', reject);
      req.end();
    });
  const rawGet: AssetTestApp['rawGet'] = (pathname, options) =>
    raw('GET', pathname, options);
  const rawPost: AssetTestApp['rawPost'] = (pathname, options) =>
    raw('POST', pathname, options);

  const plant: AssetTestApp['plant'] = async (s, ageMs, opts = {}) => {
    const bytes = randomBytes(4_000);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await storage.put(
      chunkKey(s.shopId, hash),
      bytes,
      'application/octet-stream',
    );
    await db.query(
      `INSERT INTO "AssetShopUsage" ("shopId") VALUES (:shopId) ON CONFLICT DO NOTHING`,
      { replacements: { shopId: s.shopId } },
    );
    await db.query(
      `INSERT INTO "AssetChunk" ("shopId", "hash", "size", "refCount", "unreferencedSince", "storedAt", "protectedUntil", "reserved")
       VALUES (:shopId, :hash, 4000, :refCount, :since, :since, :protectedUntil, false)`,
      {
        replacements: {
          shopId: s.shopId,
          hash,
          refCount: opts.refCount ?? 0,
          since: new Date(clock.now().getTime() - ageMs),
          protectedUntil: opts.protectedUntil ?? null,
        },
      },
    );
    await db.query(
      `UPDATE "AssetShopUsage" SET "storedBytes" = "storedBytes" + 4000 WHERE "shopId" = :shopId`,
      { replacements: { shopId: s.shopId } },
    );
    return { bytes, hash };
  };
  const orders = app.get(AssetOrdersConsumer);
  const shopEvents = app.get(AssetCatalogShopConsumer);
  const product: AssetTestApp['product'] = async (s, title) => {
    const created = await createProduct(
      app,
      { id: s.shopId },
      title ? { title } : {},
    );
    return { id: created.id };
  };
  const link: AssetTestApp['link'] = (s, productId, assetId) =>
    http()
      .put(
        `/api/shops/${s.shopId}/products/${productId}/digital-asset/${assetId}`,
      )
      .set(s.auth);
  const buy: AssetTestApp['buy'] = async (s, buyer, productId, title) => {
    const payload = paidPayload({
      userId: buyer.id,
      lines: [{ productId, shopId: s.shopId, title: title ?? 'E-book' }],
    });
    const outcome = await deliver(orders, paidEvent(payload));
    if (!outcome.delivered) throw new Error('order.paid was dead-lettered');
    return payload.orderId;
  };

  return {
    app,
    clock,
    db,
    orders,
    shopEvents,
    plant,
    product,
    link,
    buy,
    rawGet,
    rawPost,
    storage,
    hub,
    store,
    config,
    http,
    advance,
    setTime,
    user,
    seller,
    member,
    rows,
    outbox: (aggregateId) => outboxRowsFor(app, aggregateId),
    logLines: () => logs.join(''),
    close: async () => {
      await app.close();
      writeSpy?.mockRestore();
    },
    chunksOf,
    prepare,
    putMissing,
    commit,
    commitEmpty,
    save,
    download,
    randomBytes: (n) => randomBytes(n),
  };
}
