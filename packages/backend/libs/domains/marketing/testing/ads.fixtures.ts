import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { parseJobPayload } from '@app/infrastructure/jobs/job-type-registry';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import type { AdCampaign } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import type { FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { createTopics, deleteTopicsMatching } from '@app/test/utils/kafka-test';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
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
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { AdsModule } from '../ads.module';
import {
  AGGREGATE_READER,
  BILLING_STORE,
  CAMPAIGN_STORE,
  CATALOG_PORT,
  CLICK_LOG,
  IMPRESSION_MARKER,
  PRODUCT_SNAPSHOT_STORE,
  RAW_CLICK_READER,
  SHOP_DIRECTORY_PORT,
  SHOP_SNAPSHOT_STORE,
  SPAM_COUNTERS,
  SPEND_COUNTER,
  AdsDependencyUnavailableError,
  type ProductSnapshot,
  type ShopSnapshot,
} from '../domain/ads-ports';
import { CatalogAdapter } from '../infra/catalog.adapter';
import { ClickhouseAdReader } from '../infra/clickhouse-ad.reader';
import { KafkaClickLog } from '../infra/kafka-click.log';
import { RedisImpressionMarker } from '../infra/redis-impression.marker';
import { RedisSpamCounters } from '../infra/redis-spam.counters';
import { RedisSpendCounter } from '../infra/redis-spend.counter';
import { SequelizeBillingStore } from '../infra/sequelize-billing.store';
import { SequelizeCampaignStore } from '../infra/sequelize-campaign.store';
import {
  SequelizeProductSnapshotStore,
  SequelizeShopSnapshotStore,
} from '../infra/sequelize-snapshot.stores';
import { ShopDirectoryAdapter } from '../infra/shop-directory.adapter';

/** Storefront origin the specs run against (the test environment's own `FRONT_HOST` is plain http). */
export const FRONT = 'https://shop.example';

export type FaultMode =
  | { kind: 'down'; times?: number }
  | { kind: 'delay'; ms: number }
  | { kind: 'hang' };

/** Dependency keys a spec can break; `dep.method` narrows the fault to one call. */
export type Dependency =
  | 'campaigns'
  | 'productSnapshots'
  | 'shopSnapshots'
  | 'billing'
  | 'marker'
  | 'spam'
  | 'spend'
  | 'log'
  | 'raw'
  | 'aggregates'
  | 'catalog'
  | 'shops'
  | 'ledger';

type PortBinding = {
  dep: Dependency;
  token: symbol;
  real: new (...a: any[]) => object;
};

/** The ports every ads app has, bound to their real adapter classes; the worker adds `ledger` through `options.ports`. */
const DEFAULT_PORTS: PortBinding[] = [
  { dep: 'campaigns', token: CAMPAIGN_STORE, real: SequelizeCampaignStore },
  {
    dep: 'productSnapshots',
    token: PRODUCT_SNAPSHOT_STORE,
    real: SequelizeProductSnapshotStore,
  },
  {
    dep: 'shopSnapshots',
    token: SHOP_SNAPSHOT_STORE,
    real: SequelizeShopSnapshotStore,
  },
  { dep: 'billing', token: BILLING_STORE, real: SequelizeBillingStore },
  { dep: 'marker', token: IMPRESSION_MARKER, real: RedisImpressionMarker },
  { dep: 'spam', token: SPAM_COUNTERS, real: RedisSpamCounters },
  { dep: 'spend', token: SPEND_COUNTER, real: RedisSpendCounter },
  { dep: 'log', token: CLICK_LOG, real: KafkaClickLog },
  { dep: 'raw', token: RAW_CLICK_READER, real: ClickhouseAdReader },
  { dep: 'aggregates', token: AGGREGATE_READER, real: ClickhouseAdReader },
  { dep: 'catalog', token: CATALOG_PORT, real: CatalogAdapter },
  { dep: 'shops', token: SHOP_DIRECTORY_PORT, real: ShopDirectoryAdapter },
];

export interface Team {
  shop: { id: string };
  /** OWNER, ADMIN, STAFF, VIEWER of the shop (the `OA`, `AA`, `SA`, `VA` of the spec). */
  owner: TestUser;
  admin: TestUser;
  staff: TestUser;
  viewer: TestUser;
}

export interface AdsTestApp extends CatalogTestApp {
  config: MockApiConfigService;
  clock: FakeClock;
  redis: RedisService['client'];
  /** Switch a dependency (or one of its methods) to failing, slow or hanging; `reset()` clears them all. */
  faults: Map<string, FaultMode>;
  /** Calls made through each wrapped port, keyed `campaigns.insert`, `marker.claim` ... */
  calls: Map<string, number>;
  redisProxy: TcpFaultProxy | null;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
  /** What the (spied) producer accepted, in order. */
  published: Array<{ topic: string; key: string; value: any }>;
  /** Make the producer refuse (`'down'`), never answer (`'hang'`), answer after 1.5 s (`'slow'`) or accept again (`null`). */
  producer(mode: 'down' | 'hang' | 'slow' | null): void;
  /** A shop with its four members. */
  team(): Promise<Team>;
  user(): Promise<TestUser>;
  /** A product row seeded straight into the catalog table (category `audio`, in stock, ACTIVE by default). */
  product(shopId: string, over?: ProductSeed): Promise<SeededProduct>;
  /** `POST /api/shops/:shopId/ads/campaigns` */
  create(
    user: TestUser,
    shopId: string,
    body: Record<string, unknown>,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** `POST …/campaigns/:id/(pause|resume|end)` */
  act(
    user: TestUser,
    shopId: string,
    campaignId: string,
    action: 'pause' | 'resume' | 'end',
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** Creates a campaign through the API as the team's owner and returns it (throws unless 201). */
  campaign(
    team: Team,
    over?: {
      product?: ProductSeed;
      productId?: string;
      cpcMinor?: number;
      dailyBudgetMinor?: number;
    },
  ): Promise<{ campaign: AdCampaign; product: SeededProduct }>;
  /** The envelopes in the outbox for an aggregate id, oldest first. */
  events(aggregateId: string): Promise<
    Array<{
      type: string;
      version: number;
      aggregateId: string;
      aggregateVersion: number;
      eventId: string;
      occurredAt: string;
      payload: Record<string, any>;
    }>
  >;
  /** A read-only query against the real database, rows as the driver returns them. */
  sql<T extends object = Record<string, any>>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  /**
   * Runs a job the way the worker does: through the registry that discovered its `@JobHandler` (built like
   * `JobsWorkerModule` does, without its polling loop), after the payload passed the job type's contract.
   */
  runJob(type: string, payload?: object): Promise<unknown>;
  /** Writes the read models straight through the real stores (a version above the stored one wins). */
  setProductSnapshot(
    productId: string,
    patch: Partial<ProductSnapshot>,
  ): Promise<void>;
  setShopSnapshot(shopId: string, patch: Partial<ShopSnapshot>): Promise<void>;
}

/**
 * A port wrapped so a spec can make it fail, slow or hang (VII.9, L-003: every fallback is forced, never assumed). The
 * wrapper counts calls and throws `AdsDependencyUnavailableError`, the type the real adapters throw.
 */
export function faultable<T extends object>(
  dep: Dependency,
  target: T,
  faults: Map<string, FaultMode>,
  calls: Map<string, number>,
): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const name = `${dep}.${String(prop)}`;
        calls.set(name, (calls.get(name) ?? 0) + 1);
        const key = faults.has(name) ? name : dep;
        const mode = faults.get(key);
        if (mode?.kind === 'down') {
          if (mode.times !== undefined && --mode.times <= 0) faults.delete(key);
          throw new AdsDependencyUnavailableError(dep);
        }
        if (mode?.kind === 'hang') await new Promise(() => undefined);
        if (mode?.kind === 'delay')
          await new Promise((r) => setTimeout(r, mode.ms));
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/** Binds every port token present in the graph to a fault-injecting wrapper around the real adapter. */
export function withFaultablePorts(
  builder: TestingModuleBuilder,
  ports: Array<{
    dep: Dependency;
    token: symbol;
    real: new (...a: any[]) => object;
  }>,
  faults: Map<string, FaultMode>,
  calls: Map<string, number>,
): TestingModuleBuilder {
  let b = builder;
  for (const { dep, token, real } of ports)
    b = b.overrideProvider(token).useFactory({
      factory: (adapter: object) => faultable(dep, adapter, faults, calls),
      inject: [real],
    });
  return b;
}

export interface AdsAppOptions {
  /** Further modules the spec needs (worker, projector hosts ...). */
  extraImports?: unknown[];
  /** Further builder changes, applied after the fault wrappers. */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Provider overrides that wrap further ports (`[dep, token, real class]`). */
  ports?: Array<{
    dep: Dependency;
    token: symbol;
    real: new (...a: any[]) => object;
  }>;
  /** Replace the producer's `send` with a spy that records and can refuse; default true. */
  spyProducer?: boolean;
  structuredLogger?: boolean;
  /** Put a fault proxy in front of the shared Redis (the limiter's, the marker's and the counters' store). */
  redisProxy?: boolean;
  /** Environment read once when the app boots (`TRUSTED_PROXIES` ...). */
  env?: Record<string, string>;
}

const ADS_KEY_PATTERNS = ['adclick:*', 'adspam:*', 'adspend:*'];

/**
 * The real ads modules behind the production HTTP pipeline, with real Postgres, Redis, ClickHouse and outbox. Faked at
 * the edges only: the clock (movable), the Kafka producer's `send` (a spy that can refuse or hang), and fault-injecting
 * wrappers around the project's own ports. Every spec creates its own users and data (L-005, L-006).
 */
export async function createAdsApp(
  options: AdsAppOptions = {},
): Promise<AdsTestApp> {
  const faults = new Map<string, FaultMode>();
  const calls = new Map<string, number>();
  const clockHolder: { clock?: FakeClock } = {};
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({
        host: 'localhost',
        port: Number(
          new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').port ||
            6400,
        ),
      })
    : null;
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
    ...(redisProxy && {
      redisUrl: `redis://127.0.0.1:${redisProxy.port}/${new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').pathname.slice(1) || '0'}`,
    }),
    env: options.env,
    extraImports: [AdsModule, ...(options.extraImports ?? [])],
    customize: (builder) => {
      let b = builder
        .overrideProvider(TimeSource)
        .useValue({ overrideMs: () => clockHolder.clock?.nowMs() ?? null });
      b = withFaultablePorts(
        b,
        [...DEFAULT_PORTS, ...(options.ports ?? [])],
        faults,
        calls,
      );
      return options.customize ? options.customize(b) : b;
    },
  });
  clockHolder.clock = base.clock;
  const app: INestApplication = base.app;
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const redis = app.get(RedisService).client;
  const clickhouse = app.get(ClickHouseService);
  const sequelize = app.get(Sequelize);

  // L-011: the analytics tables exist in the test stack whatever order the stack was prepared in
  await applyClickHouseDdl(clickhouse, '081_ads_v2.sql');

  let jobRegistry: JobRegistry | undefined;
  const published: AdsTestApp['published'] = [];
  let producerMode: 'down' | 'hang' | 'slow' | null = null;
  const producerService = app.get(KafkaProducerService);
  const send =
    options.spyProducer === false
      ? null
      : jest
          .spyOn(producerService, 'send')
          .mockImplementation(async (message: any) => {
            if (producerMode === 'down')
              throw new Error('broker down (injected)');
            if (producerMode === 'hang') await new Promise(() => undefined);
            if (producerMode === 'slow')
              await new Promise((r) => setTimeout(r, 1_500));
            published.push({
              topic: message.topic,
              key: message.key,
              value: message.value,
            });
          });

  const configure = () => {
    config.set('front_host', FRONT);
  };
  configure();

  const flushAdsKeys = async () => {
    for (const pattern of ADS_KEY_PATTERNS) {
      const keys = await redis.keys(pattern);
      if (keys.length) await redis.del(...keys);
    }
    const limiter = await redis.keys('rl:*');
    if (limiter.length) await redis.del(...limiter);
  };

  const t: AdsTestApp = {
    ...base,
    config,
    redis,
    faults,
    calls,
    published,
    producer: (mode) => {
      producerMode = mode;
    },
    redisProxy,
    rawLogs: () => logChunks.join(''),
    close: async () => {
      send?.mockRestore();
      stdoutSpy?.mockRestore();
      await base.close();
      await redisProxy?.close();
    },
    async reset() {
      if (redisProxy) {
        // A hung proxy swallowed requests and left the client's reply queue out of step with the server: cut the
        // connection, let it reconnect, and only then clean (L-013: damage done on purpose is repaired before the next test).
        redisProxy.mode = 'pass';
        redisProxy.sever();
        await waitFor(
          async () =>
            (await Promise.race([
              redis.ping(),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve('timeout'), 500),
              ),
            ])) === 'PONG',
          {
            description: 'redis reachable through the proxy',
            timeoutMs: 20_000,
          },
        );
      }
      await base.reset();
      config.reset();
      configure();
      faults.clear();
      calls.clear();
      published.length = 0;
      producerMode = null;
      await flushAdsKeys();
      for (const table of ['ad_clicks_log', 'ad_click_minute_v2'])
        await clickhouse
          .getClient()
          .command({ query: `TRUNCATE TABLE ${table}` });
    },
    user: () => base.newUser(),
    async team() {
      const owner = await base.newUser();
      const [admin, staff, viewer] = await Promise.all([
        base.newUser(),
        base.newUser(),
        base.newUser(),
      ]);
      const shop = await createShop(app, owner);
      await addMember(app, shop.id, admin.id, 'ADMIN');
      await addMember(app, shop.id, staff.id, 'STAFF');
      await addMember(app, shop.id, viewer.id, 'VIEWER');
      return { shop: { id: shop.id }, owner, admin, staff, viewer };
    },
    product: (shopId, over = {}) =>
      createProduct(app, { id: shopId }, { category: 'audio', ...over }),
    create: (user, shopId, body) =>
      base.as(user).post(`/api/shops/${shopId}/ads/campaigns`).send(body),
    act: (user, shopId, campaignId, action) =>
      base
        .as(user)
        .post(`/api/shops/${shopId}/ads/campaigns/${campaignId}/${action}`),
    async campaign(team, over = {}) {
      const product =
        over.productId !== undefined
          ? ({ id: over.productId } as SeededProduct)
          : await t.product(team.shop.id, over.product);
      const res = await t.create(team.owner, team.shop.id, {
        productId: product.id,
        cpcMinor: over.cpcMinor ?? 25,
        dailyBudgetMinor: over.dailyBudgetMinor ?? 1_000,
      });
      if (res.status !== 201)
        throw new Error(
          `create campaign: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return { campaign: res.body as AdCampaign, product };
    },
    async events(aggregateId) {
      const rows = await outboxRowsFor(app, aggregateId);
      return rows
        .filter((r) => r.kind === 'event')
        .map((r) => r.payload as any);
    },
    sql: (query, replacements = {}) =>
      sequelize.query(query, { type: QueryTypes.SELECT, replacements }) as any,
    async runJob(type, payload = {}) {
      if (!jobRegistry) {
        jobRegistry = new JobRegistry(
          app.get(DiscoveryService, { strict: false }),
          app.get(MetadataScanner, { strict: false }),
          app.get(Reflector, { strict: false }),
        );
        jobRegistry.onModuleInit();
      }
      const handler = jobRegistry.get(type);
      if (!handler) throw new Error(`no @JobHandler for ${type}`);
      return handler.run(parseJobPayload(type, payload), {
        jobId: uuidv4(),
        attempt: 1,
        maxAttempts: 3,
        isLastAttempt: false,
        heartbeat: () => Promise.resolve(),
        signal: new AbortController().signal,
      });
    },
    async setProductSnapshot(productId, patch) {
      const [current] = await t.sql<ProductSnapshot>(
        `SELECT * FROM "AdProductSnapshot" WHERE "productId" = :productId`,
        { productId },
      );
      await realProductStore(app).upsertIfNewer(
        {
          ...current,
          ...patch,
          productVersion: patch.productVersion ?? current.productVersion + 1,
        },
        base.clock.now(),
      );
    },
    async setShopSnapshot(shopId, patch) {
      const [current] = await t.sql<ShopSnapshot>(
        `SELECT * FROM "AdShopSnapshot" WHERE "shopId" = :shopId`,
        { shopId },
      );
      await realShopStore(app).upsertIfNewer(
        {
          ...current,
          ...patch,
          shopVersion: patch.shopVersion ?? current.shopVersion + 1,
        },
        base.clock.now(),
      );
    },
  };
  return t;
}

/** The unwrapped snapshot stores, for set-up writes that must bypass the fault wrappers. */
const realProductStore = (app: INestApplication) =>
  app.get(SequelizeProductSnapshotStore);
const realShopStore = (app: INestApplication) =>
  app.get(SequelizeShopSnapshotStore);

/** A fresh unique id, for specs that need an unknown campaign, shop or product. */
export const unknownId = () => uuidv4();

/**
 * Deletes and recreates the three ads topics (L-002, L-011): 10 partitions for the clicks (the 10 salted keys of one
 * campaign spread over them), a few for the aggregates, one for the dead letters. A spec starts from empty topics and
 * fresh consumer group ids, so what ran before it can never be read as its own data (L-006).
 */
export async function resetAdsTopics(): Promise<void> {
  await deleteTopicsMatching(/^ads\.(clicks|click-aggregates|clicks\.dlq)$/);
  // a deleted topic may take a moment to disappear from the broker's metadata
  for (let attempt = 0; ; attempt++) {
    try {
      await createTopics([
        { topic: 'ads.clicks', numPartitions: 10 },
        { topic: 'ads.click-aggregates', numPartitions: 3 },
        { topic: 'ads.clicks.dlq', numPartitions: 1 },
      ]);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
