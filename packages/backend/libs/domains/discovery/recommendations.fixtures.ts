import { randomUUID } from 'node:crypto';
import { Pipeline } from 'ioredis';
import Redis from 'ioredis';
import {
  problemDetailsSchema,
  recommendationsResponseSchema,
  type RecommendationsResponse,
} from '@marketplace-sandbox/contracts';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { JobWorker } from '@app/infrastructure/jobs/job-worker.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OrderPaid } from '@app/domains/orders';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import {
  createProduct,
  type ProductSeed,
} from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { RecommendationsModule } from './recommendations.module';
import { RecommendationsProjectorModule } from './recommendations-projector.module';
import { RecommendationsWorkerModule } from './recommendations-worker.module';
import { CoOccurrenceJobs } from './infra/co-occurrence.jobs';
import { OrderBasketsProjector } from './infra/projectors/order-baskets.projector';
import { BOUGHT_TOGETHER_PATTERN, boughtTogetherKey } from './infra/recommendation-keys';

export const RECOMMENDATION_KEY_PATTERNS = ['rec:*'] as const;

export interface RecommendationsTestApp extends CatalogTestApp {
  redis: RedisService;
  clickhouse: ClickHouseService;
  jobs: JobsService;
  worker: JobWorker;
  /** In front of Redis, when `redisProxy: true`. */
  redisProxy: TcpFaultProxy | null;
  /** Empties every store: database, clock, baskets, and the whole `rec:*` keyspace. */
  clean(): Promise<void>;
  /** `GET /api/products/:id/recommendations`, 200 parsed with the response schema. */
  rail(productId: string, query?: Record<string, string>): Promise<RecommendationsResponse>;
  /** Delivers real `order.paid` envelopes to the real consumer entry point. */
  deliverPaid(...orders: PaidOrder[]): Promise<void>;
  /** The nightly build through the real handler of the real job. */
  build(payload?: { days?: number; buckets?: number }): Promise<BuildResult>;
  /** The stored list of a product straight from Redis: `[member, score]` best first. */
  storedList(productId: string): Promise<[string, number][]>;
  /** Every `rec:bought:*` key. */
  listKeys(): Promise<string[]>;
  /** Writes a list straight into the keyspace (fixtures for the read path); fires no build. */
  putList(productId: string, entries: [string, number][], ttlSeconds?: number): Promise<void>;
  /** Stored baskets, read with FINAL. */
  baskets(): Promise<StoredBasket[]>;
}

export interface BuildResult {
  outcome: 'completed' | 'skipped_empty' | 'skipped_locked';
  products: number;
  edges: number;
  removed: number;
}

export interface StoredBasket {
  order_id: string;
  buyer_id: string;
  products: string[];
  paid_at: string;
  order_version: number;
}

export interface PaidOrder {
  orderId?: string;
  userId?: string;
  productIds: string[];
  orderVersion?: number;
  paidAt?: Date;
  /** Quantity per line (default 1). */
  quantity?: number;
}

export const newId = (): string => randomUUID();

export const paidEnvelope = (order: PaidOrder): EventEnvelope => {
  const orderId = order.orderId ?? newId();
  const version = order.orderVersion ?? 1;
  const paidAt = (order.paidAt ?? new Date()).toISOString();
  return OrderPaid.create(
    orderId,
    version,
    {
      orderId,
      userId: order.userId ?? newId(),
      orderVersion: version,
      totalMinor: 1_000 * order.productIds.length,
      currency: 'USD',
      paymentRef: `pay-${orderId.slice(0, 8)}`,
      paidAt,
      lines: order.productIds.map((productId) => ({
        productId,
        shopId: null,
        title: 'Line',
        quantity: order.quantity ?? 1,
        unitPriceMinor: 1_000,
        discountMinor: 0,
        lineTotalMinor: 1_000 * (order.quantity ?? 1),
      })),
      shopOrders: [],
    },
    new Date(paidAt),
  );
};

export async function createRecommendationsApp(
  options: {
    redisProxy?: boolean;
    env?: Record<string, string>;
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
  } = {},
): Promise<RecommendationsTestApp> {
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({ host: 'localhost', port: 6400 })
    : null;
  const base = await createCatalogApp({
    ...(redisProxy ? { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` } : {}),
    extraImports: [
      JobsModule,
      JobsWorkerModule.register({ loops: false }),
      RecommendationsModule,
      RecommendationsWorkerModule,
      RecommendationsProjectorModule,
    ],
    overrides: options.overrides,
    env: options.env,
  });
  const clickhouse = base.app.get(ClickHouseService, { strict: false });
  const redis = base.app.get(RedisService, { strict: false });
  await applyClickHouseDdl(clickhouse, '041_recommendation_baskets.sql');

  const flushKeys = async () => {
    const keys = await redis.client.keys('rec:*');
    if (keys.length > 0) await redis.client.del(...keys);
  };

  const t: RecommendationsTestApp = {
    ...base,
    redis,
    clickhouse,
    redisProxy,
    jobs: base.app.get(JobsService, { strict: false }),
    worker: base.app.get(JobWorker, { strict: false }),
    async clean() {
      if (redisProxy) {
        redisProxy.mode = 'pass';
        redisProxy.delayMs = 0;
      }
      await base.reset();
      await clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE recommendation_baskets' });
      await flushKeys();
    },
    async rail(productId, query = {}) {
      const res = await base
        .http()
        .get(`/api/products/${productId}/recommendations`)
        .query(query)
        .expect(200);
      return recommendationsResponseSchema.parse(res.body);
    },
    async deliverPaid(...orders) {
      await base.app
        .get(OrderBasketsProjector, { strict: false })
        .project(orders.map(paidEnvelope));
    },
    build: (payload = {}) =>
      base.app.get(CoOccurrenceJobs, { strict: false }).build(payload) as Promise<BuildResult>,
    async storedList(productId) {
      const flat = await redis.client.zrevrange(
        boughtTogetherKey(productId),
        0,
        -1,
        'WITHSCORES',
      );
      const out: [string, number][] = [];
      for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
      return out;
    },
    async listKeys() {
      return (await redis.client.keys(BOUGHT_TOGETHER_PATTERN)).sort();
    },
    async putList(productId, entries, ttlSeconds = 3_600) {
      const key = boughtTogetherKey(productId);
      await redis.client.del(key);
      if (entries.length > 0)
        await redis.client.zadd(key, ...entries.flatMap(([m, s]) => [s, m]));
      await redis.client.expire(key, ttlSeconds);
    },
    async baskets() {
      const result = await clickhouse.getClient().query({
        query:
          'SELECT order_id, buyer_id, products, toString(paid_at) AS paid_at, order_version FROM recommendation_baskets FINAL ORDER BY order_id',
        format: 'JSONEachRow',
      });
      return (await result.json()) as StoredBasket[];
    },
    async close() {
      await base.close();
      await redisProxy?.close();
    },
  };
  return t;
}

/** Dataset D of the spec: products `P` (hub), `M`, `C`, `K`, `S`, and the baskets of groups g1-g6, every buyer different. */
export interface DatasetD {
  shopId: string;
  P: string;
  M: string;
  C: string;
  K: string;
  S: string;
}

const GROUPS: [string, string, number][] = [
  ['P', 'M', 6],
  ['P', 'K', 40],
  ['P', 'C', 40],
  ['M', 'C', 5],
  ['M', 'S', 2],
  ['K', 'S', 3],
];

export async function seedCatalog(
  t: RecommendationsTestApp,
): Promise<DatasetD & { shop: { id: string } }> {
  const owner = await t.newUser();
  const shop = await createShop(t.app, owner);
  const make = (title: string, over: ProductSeed = {}) =>
    createProduct(t.app, shop, { title, ...over }).then((p) => p.id);
  const [P, M, C, K, S] = await Promise.all([
    make('iPhone 17', { priceMinor: 99_900 }),
    make('MagSafe Charger', { priceMinor: 3_900 }),
    make('iPhone 17 Case', { priceMinor: 4_900 }),
    make('USB-C Cable', { priceMinor: 1_900 }),
    make('Charging Stand', { priceMinor: 5_900 }),
  ]);
  return { shop, shopId: shop.id, P, M, C, K, S };
}

/** Catalog plus the paid orders of dataset D, delivered to the real consumer; the build is left to the caller. */
export async function seedDatasetD(
  t: RecommendationsTestApp,
  paidAt: Date = t.clock.now(),
): Promise<DatasetD & { shop: { id: string } }> {
  const d = await seedCatalog(t);
  const orders: PaidOrder[] = GROUPS.flatMap(([a, b, count]) =>
    Array.from({ length: count }, () => ({
      productIds: [d[a as 'P'], d[b as 'P']],
      paidAt,
    })),
  );
  await t.deliverPaid(...orders);
  return d;
}

/** Counts Redis commands by name (and pipeline round trips) through the real client; `stop()` restores it. */
export function countRedisCommands() {
  const commands: Record<string, number> = {};
  const trips = { pipelines: 0 };
  const count = (command: { name?: string }) => {
    const name = String(command?.name ?? 'unknown').toLowerCase();
    commands[name] = (commands[name] ?? 0) + 1;
  };
  const sendCommand = Redis.prototype.sendCommand;
  const pipelineSend = Pipeline.prototype.sendCommand;
  const exec = Pipeline.prototype.exec;
  Redis.prototype.sendCommand = function (this: Redis, command: never, ...rest: never[]) {
    count(command);
    return (sendCommand as (...a: unknown[]) => unknown).call(this, command, ...rest) as never;
  } as never;
  Pipeline.prototype.sendCommand = function (this: Pipeline, command: never, ...rest: never[]) {
    count(command);
    return (pipelineSend as (...a: unknown[]) => unknown).call(this, command, ...rest) as never;
  } as never;
  Pipeline.prototype.exec = function (this: Pipeline, ...args: never[]) {
    trips.pipelines += 1;
    return (exec as (...a: unknown[]) => unknown).apply(this, args) as never;
  } as never;
  return {
    commands,
    trips,
    reset() {
      for (const k of Object.keys(commands)) delete commands[k];
      trips.pipelines = 0;
    },
    stop() {
      Redis.prototype.sendCommand = sendCommand;
      Pipeline.prototype.sendCommand = pipelineSend;
      Pipeline.prototype.exec = exec;
    },
  };
}

export const problem = (body: unknown) => {
  const parsed = problemDetailsSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  return body as {
    code: string;
    status: number;
    errors?: { field: string }[];
  };
};
