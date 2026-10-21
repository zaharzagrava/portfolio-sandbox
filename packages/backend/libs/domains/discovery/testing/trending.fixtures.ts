import { randomUUID } from 'node:crypto';
import Redis, { Pipeline } from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { Kafka } from 'kafkajs';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { trendingResponseSchema } from '@marketplace-sandbox/contracts';
import type { TrendingResponse } from '@marketplace-sandbox/contracts';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createTopics,
  deleteTopicsMatching,
  testKafka,
} from '@app/test/utils/kafka-test';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { TrendingIngestService } from '../application/trending-ingest.service';
import {
  TRENDING_CONSUMER_OPTIONS,
  TRENDING_PROCESS_EXIT,
  TrendingConsumer,
} from '../infra/trending.consumer';
import { TrendingModule, TrendingProjectorModule } from '../trending.module';
import { RedisTrendingAggregateAdapter } from '../infra/redis-trending-aggregate.adapter';
import { aggregateKey } from '../infra/trending-keys';

export const DAY = '2026-10-10';
export const MIN = 60_000;
/** `HH:mm:ss` of the spec's frozen day as epoch milliseconds. */
export const at = (hhmmss: string): number =>
  Date.parse(`${DAY}T${hhmmss}${hhmmss.length === 5 ? ':00' : ''}Z`);
export const windowOf = (hhmmss: string): number =>
  Math.floor(at(hhmmss) / MIN) * MIN;

/** Small sketches and filters, no timer: specs drive the idle clock and merge cycle themselves. */
export const TRENDING_TEST_ENV = {
  TRENDING_TICK_MS: '600000',
  TRENDING_FILTER_BITS: '65536',
  TRENDING_ALL_WIDTH: '4096',
  TRENDING_CATEGORY_WIDTH: '1024',
  TRENDING_MERGE_BACKOFF_BASE_MS: '5',
  TRENDING_CONNECT_TIMEOUT_MS: '3000',
};

export interface EventSpec {
  name?: string;
  productId?: string | null;
  category?: string | null;
  /** `HH:mm:ss` on the frozen day. */
  at: string;
  receivedAt?: string;
  visitor?: string;
  eventId?: string;
  props?: Record<string, string>;
  /** Replaces the formatted `ts` (for forged or broken values). */
  ts?: string;
}

const chTime = (hhmmss: string) =>
  `${DAY} ${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}${hhmmss.includes('.') ? '' : '.000'}`;

/** A stored analytics event as S39 publishes it. */
export function storedEvent(spec: EventSpec) {
  const props: Record<string, string> = { ...spec.props };
  if (spec.productId) props.product_id = spec.productId;
  if (spec.category) props.category = spec.category;
  return {
    event_id: spec.eventId ?? randomUUID(),
    name: spec.name ?? 'product_view',
    anonymous_id: spec.visitor ?? `visitor-${randomUUID().slice(0, 12)}`,
    user_id: '',
    ts: spec.ts ?? chTime(spec.at),
    received_at: chTime(spec.receivedAt ?? spec.at),
    country: 'DE',
    platform: 'web',
    page: '/',
    props,
  };
}

export interface Produced {
  partition: number;
  offset: number;
}

export interface Dataset {
  shopId: string;
  A: SeededProduct;
  B: SeededProduct;
  C: SeededProduct;
  D: SeededProduct;
}

export interface TrendingTestApp extends CatalogTestApp {
  redis: RedisService;
  redisProxy: TcpFaultProxy | null;
  topic: string;
  groupId: string;
  /** Every call of the process exit the consumer made. */
  exits: number[];
  consumer: TrendingConsumer;
  ingest: TrendingIngestService;
  clean(): Promise<void>;
  /** Puts messages on the spec's topic (key = visitor) and remembers where they landed. */
  produce(
    messages: (object | string | Buffer)[],
    options?: { partition?: number },
  ): Promise<Produced[]>;
  /** Waits until everything produced so far is consumed and the merge cycle of its batch has finished. */
  settle(): Promise<void>;
  /** Adds a ranking to one window of a category through the real merge (its own partition, so it is never a replay). */
  seedRanking(
    entries: { productId: string; score: number }[],
    options?: { category?: string; window?: string },
  ): Promise<void>;
  /** `[member, score]` of a stored aggregate, best first. */
  aggregate(
    category: string,
    windowStartMs: number,
  ): Promise<[string, number][]>;
  ttl(key: string): Promise<number>;
  keys(pattern?: string): Promise<string[]>;
  committed(): Promise<Record<number, number>>;
  /** `GET /api/trending`, 200 parsed with the response schema. */
  trending(query?: Record<string, string>): Promise<TrendingResponse>;
  /** Parses an error body with the platform problem schema. */
  problem(body: unknown): ReturnType<typeof problemDetailsSchema.parse>;
  /** Products A, B, C (`audio`) and D (`cameras`) in an active shop. */
  seedProducts(
    overrides?: Partial<Record<'A' | 'B' | 'C' | 'D', ProductSeed>>,
  ): Promise<Dataset>;
  /** Dataset T of the spec (weighted totals A 30, B 35, C 3, D 22), through the real topic and consumer, merged. */
  seedDatasetT(): Promise<Dataset>;
}

export interface TrendingAppOptions {
  partitions?: number;
  env?: Record<string, string>;
  redisProxy?: boolean;
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
  groupId?: string;
  topic?: string;
  /** Start from the beginning of an existing topic (a restarted instance). */
  fromBeginning?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seeded = 0;

/** Produces to a topic and tracks the highest offset per partition, for `settle`. */
class TopicWriter {
  private readonly kafka: Kafka = testKafka();
  private producer = this.kafka.producer();
  private connected = false;
  readonly last = new Map<number, number>();

  async send(
    topic: string,
    messages: (object | string | Buffer)[],
    partition = 0,
  ): Promise<Produced[]> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
    const encoded = messages.map((m) => {
      if (typeof m === 'string' || Buffer.isBuffer(m))
        return { key: null, value: m };
      return {
        key: (m as { anonymous_id?: string }).anonymous_id ?? null,
        value: JSON.stringify(m),
      };
    });
    const meta = await this.producer.send({
      topic,
      messages: encoded.map((e) => ({ ...e, partition })),
      acks: -1,
    });
    const base = Number(meta[0].baseOffset);
    const out = encoded.map((_, i) => ({ partition, offset: base + i }));
    this.last.set(partition, base + encoded.length - 1);
    return out;
  }

  async close() {
    if (this.connected) await this.producer.disconnect();
  }
}

/** Removes the topics the specs created (the test broker caps total partitions). */
export const deleteTrendingTopics = () =>
  deleteTopicsMatching(/^analytics\.events\.s35\./);

export async function createTrendingTopic(partitions = 1): Promise<string> {
  const topic = `analytics.events.s35.${randomUUID().slice(0, 8)}`;
  await createTopics([{ topic, numPartitions: partitions }]);
  return topic;
}

export async function createTrendingApp(
  options: TrendingAppOptions = {},
): Promise<TrendingTestApp> {
  const topic =
    options.topic ?? (await createTrendingTopic(options.partitions));
  const groupId =
    options.groupId ?? `trending-spec-${randomUUID().slice(0, 8)}`;
  // the shard's Redis (host, port and database number come from REDIS_URL)
  const redisTarget = new URL(
    process.env.REDIS_URL ?? 'redis://localhost:6400/0',
  );
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({
        host: redisTarget.hostname,
        port: Number(redisTarget.port || 6379),
      })
    : null;
  const exits: number[] = [];
  const base = await createCatalogApp({
    ...(redisProxy
      ? { redisUrl: `redis://127.0.0.1:${redisProxy.port}/${redisTarget.pathname.slice(1) || '0'}` }
      : {}),
    extraImports: [TrendingModule, TrendingProjectorModule],
    env: { ...TRENDING_TEST_ENV, ...options.env },
    overrides: [
      {
        provide: TRENDING_CONSUMER_OPTIONS,
        useValue: {
          groupId,
          topic,
          fromBeginning: options.fromBeginning ?? true,
        },
      },
      {
        provide: TRENDING_PROCESS_EXIT,
        useValue: (c: number) => exits.push(c),
      },
      ...(options.overrides ?? []),
    ],
  });
  const consumer = base.app.get(TrendingConsumer, { strict: false });
  await consumer.whenReady();
  return wrap(base, {
    topic,
    groupId,
    redisProxy,
    exits,
    consumer,
    ingest: base.app.get(TrendingIngestService, { strict: false }),
  });
}

/** Another consumer process of the same topic and group (a moved partition, a restart): no HTTP, no catalog. */
export async function createProjectorOnly(options: {
  topic: string;
  groupId: string;
  fromBeginning?: boolean;
  clock?: FakeClock;
  env?: Record<string, string>;
  overrides?: Array<{ provide: unknown; useValue: unknown }>;
}) {
  const exits: number[] = [];
  const clock = options.clock ?? new FakeClock(new Date(`${DAY}T12:07:10Z`));
  const previous: Record<string, string | undefined> = {};
  const env = { ...TRENDING_TEST_ENV, ...options.env };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule([TrendingProjectorModule], {
      stores: ['redis'],
      customize: (builder) => {
        let b = builder.overrideProvider(CLOCK).useValue(clock);
        b = b.overrideProvider(TRENDING_CONSUMER_OPTIONS).useValue({
          groupId: options.groupId,
          topic: options.topic,
          fromBeginning: options.fromBeginning ?? true,
        });
        b = b
          .overrideProvider(TRENDING_PROCESS_EXIT)
          .useValue((c: number) => exits.push(c));
        for (const o of options.overrides ?? [])
          b = b.overrideProvider(o.provide).useValue(o.useValue);
        return b;
      },
    });
    app = moduleRef.createNestApplication({ bufferLogs: false });
    await app.init();
  } finally {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  const consumer = app.get(TrendingConsumer, { strict: false });
  return {
    app,
    clock,
    exits,
    consumer,
    ingest: app.get(TrendingIngestService, { strict: false }),
    close: () => app.close(),
  };
}

function wrap(
  base: CatalogTestApp,
  parts: {
    topic: string;
    groupId: string;
    redisProxy: TcpFaultProxy | null;
    exits: number[];
    consumer: TrendingConsumer;
    ingest: TrendingIngestService;
  },
): TrendingTestApp {
  const redis = base.app.get(RedisService, { strict: false });
  const writer = new TopicWriter();
  const t: TrendingTestApp = {
    ...base,
    ...parts,
    redis,
    async clean() {
      if (parts.redisProxy) {
        parts.redisProxy.mode = 'pass';
        parts.redisProxy.delayMs = 0;
      }
      await base.reset();
      base.clock.set(new Date(`${DAY}T12:07:10Z`));
      // a fresh consumer state: windows and watermarks of the previous test must not shape this one
      parts.ingest.reset();
    },
    async seedRanking(entries, options = {}) {
      const category = options.category ?? 'all';
      const writer = base.app.get(RedisTrendingAggregateAdapter, {
        strict: false,
      });
      await writer.mergeWindow({
        partition: 1_000 + seeded++,
        windowStartMs: windowOf(options.window ?? '12:00'),
        firstOffset: 0,
        lastOffset: 0,
        categories: [{ category, entries }],
      });
    },
    async produce(messages, opts = {}) {
      return writer.send(parts.topic, messages, opts.partition ?? 0);
    },
    async settle() {
      await waitFor(
        () => {
          const positions = parts.ingest.positions();
          for (const [partition, last] of writer.last)
            if ((positions.get(partition) ?? -1) < last)
              return Promise.resolve(false);
          return Promise.resolve(parts.consumer.activeBatches() === 0);
        },
        { description: 'consumer settled', timeoutMs: 20_000, intervalMs: 25 },
      );
    },
    async aggregate(category, windowStartMs) {
      const flat = await redis.client.zrevrange(
        aggregateKey(category, windowStartMs),
        0,
        -1,
        'WITHSCORES',
      );
      const out: [string, number][] = [];
      for (let i = 0; i < flat.length; i += 2)
        out.push([flat[i], Number(flat[i + 1])]);
      return out;
    },
    ttl: (key) => redis.client.ttl(key),
    keys: async (pattern = 'trending:*') =>
      (await redis.client.keys(pattern)).sort(),
    async committed() {
      const admin = testKafka().admin();
      await admin.connect();
      try {
        const rows = await admin.fetchOffsets({
          groupId: parts.groupId,
          topics: [parts.topic],
        });
        const out: Record<number, number> = {};
        for (const r of rows)
          for (const p of r.partitions)
            if (Number(p.offset) >= 0) out[p.partition] = Number(p.offset);
        return out;
      } finally {
        await admin.disconnect();
      }
    },
    async trending(query = {}) {
      const res = await base
        .http()
        .get('/api/trending')
        .query(query)
        .expect(200);
      return trendingResponseSchema.parse(res.body);
    },
    problem: (body) => problemDetailsSchema.parse(body),
    async seedProducts(overrides = {}) {
      const owner = await base.newUser();
      const shop = await createShop(base.app, owner);
      const make = (key: 'A' | 'B' | 'C' | 'D', seed: ProductSeed) =>
        createProduct(base.app, shop, { ...seed, ...overrides[key] });
      const [A, B, C, D] = await Promise.all([
        make('A', { title: 'Speaker A', category: 'audio', priceMinor: 4_900 }),
        make('B', {
          title: 'Headphones B',
          category: 'audio',
          priceMinor: 9_900,
        }),
        make('C', { title: 'Cable C', category: 'audio', priceMinor: 900 }),
        make('D', {
          title: 'Camera D',
          category: 'cameras',
          priceMinor: 49_900,
        }),
      ]);
      return { shopId: shop.id, A, B, C, D };
    },
    async seedDatasetT() {
      const d = await t.seedProducts();
      const views = (id: string, category: string, minute: string, n: number) =>
        Array.from({ length: n }, () =>
          storedEvent({ productId: id, category, at: `${minute}:30` }),
        );
      const carts = (id: string, category: string, minute: string, n: number) =>
        Array.from({ length: n }, () =>
          storedEvent({
            name: 'add_to_cart',
            productId: id,
            category,
            at: `${minute}:40`,
          }),
        );
      await t.produce([
        ...views(d.A.id, 'audio', '12:00', 30),
        ...views(d.B.id, 'audio', '12:01', 10),
        ...carts(d.B.id, 'audio', '12:01', 5),
        ...views(d.C.id, 'audio', '12:02', 3),
        ...views(d.D.id, 'cameras', '12:03', 12),
        ...carts(d.D.id, 'cameras', '12:03', 2),
        // moves the watermark to 12:04:00: the four windows close and merge
        storedEvent({
          productId: randomUUID(),
          category: 'audio',
          at: '12:06:00',
        }),
      ]);
      await t.settle();
      return d;
    },
    async close() {
      await writer.close();
      await base.close();
      await parts.redisProxy?.close();
    },
  };
  return t;
}

/** Counts Redis commands by name through the real client; `stop()` restores it. Used for "no store consulted" and "one read". */
export function countRedisCommands() {
  const commands: Record<string, number> = {};
  const seen = new WeakSet<object>();
  const count = (command: { name?: string }) => {
    if (seen.has(command)) return;
    seen.add(command);
    const name = String(command?.name ?? 'unknown').toLowerCase();
    commands[name] = (commands[name] ?? 0) + 1;
  };
  const sendCommand = Redis.prototype.sendCommand;
  const pipelineSend = Pipeline.prototype.sendCommand;
  Redis.prototype.sendCommand = function (
    this: Redis,
    command: never,
    ...rest: never[]
  ) {
    count(command);
    return (sendCommand as (...a: unknown[]) => unknown).call(
      this,
      command,
      ...rest,
    ) as never;
  } as never;
  Pipeline.prototype.sendCommand = function (
    this: Pipeline,
    command: never,
    ...rest: never[]
  ) {
    count(command);
    return (pipelineSend as (...a: unknown[]) => unknown).call(
      this,
      command,
      ...rest,
    ) as never;
  } as never;
  return {
    commands,
    /** `ZUNION` commands issued (the aggregate reads). */
    get unions() {
      return commands['zunion'] ?? 0;
    },
    total: () => Object.values(commands).reduce((a, b) => a + b, 0),
    reset() {
      for (const k of Object.keys(commands)) delete commands[k];
    },
    stop() {
      Redis.prototype.sendCommand = sendCommand;
      Pipeline.prototype.sendCommand = pipelineSend;
    },
  };
}

export { sleep, waitFor };
