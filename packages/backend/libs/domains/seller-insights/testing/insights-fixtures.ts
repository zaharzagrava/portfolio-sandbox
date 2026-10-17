import { Logger, type INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type Redis from 'ioredis';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  consumedEnvelope,
  eventEnvelopeSchema,
  orderPaidEnvelope,
  orderRefundedEnvelope,
  orderReservedEnvelope,
  productDeletedPayloadSchema,
  productSnapshotSchema,
  shopCreatedEnvelope,
  shopDeletedEnvelope,
  shopUpdatedEnvelope,
  type OrderPaidInput,
  type PaidLineInput,
} from '@marketplace-sandbox/contracts';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { TransientError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import {
  RealtimePublisher,
  RealtimeStreamModule,
  RealtimeSubscriptions,
} from '@app/infrastructure/realtime';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  AuthApiModule,
  IdentityTopicsModule,
  KeyStore,
} from '@app/domains/identity';
import { ShopTopicsModule } from '@app/domains/tenancy';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse, type SseResult } from '@app/test/utils/sse-client';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { insightsMetrics } from '../application/seller-insights.metrics';
import { SnapshotService } from '../application/snapshot.service';
import type { SnapshotResult } from '../application/snapshot.service';
import { periodOf, type Period } from '../domain/periods';
import { LeaderboardsModule } from '../leaderboards.module';
import { LeaderboardsWorkerModule } from '../leaderboards-worker.module';
import {
  DashboardTicker,
  DASHBOARD_TICKER_OPTIONS,
} from '../infra/dashboard-ticker.service';
import { INSIGHTS_CLICKHOUSE } from '../infra/clickhouse-sales-history';
import { INSIGHTS_REDIS } from '../infra/redis-board.repository';
import {
  LIVE_COUNTER_REPOSITORY,
  type LiveCounterRepository,
} from '../domain/ports';
import { BoardProjector } from '../infra/projectors/board.projector';
import { LiveProjector } from '../infra/projectors/live.projector';
import {
  ProductCategoryProjector,
  ShopNameProjector,
} from '../infra/projectors/read-model.projectors';
import { SalesProjector } from '../infra/projectors/sales.projector';
import { SellerInsightsProjectorModule } from '../seller-insights-projector.module';
import { SellerStatsModule } from '../seller-stats.module';
import { SnapshotJobs } from '../infra/snapshot.jobs';

/** The frozen "now" of the S40 scenarios: a Tuesday in ISO week 2026-W41 and month 2026-10. */
export const T0 = new Date('2026-10-06T12:00:00.000Z');

export interface TestUser {
  id: string;
  email: string;
  /** `Bearer <access token>` */
  bearer: string;
}

export type ShopRole = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';

/** Switchable failures at the store edges (all off after `reset()`). */
export interface InsightsFaults {
  /** Every command on the board / counter / lease Redis client fails. */
  redisDown: boolean;
  /** The next `times` commands whose name and arguments match fail once each (a script rejected before it ran). */
  redisFail: {
    match: (command: string, args: unknown[]) => boolean;
    times: number;
  } | null;
  /** `down`: calls fail at once; `slow`: calls stall for their own timeout, then fail as a timeout does. */
  analytics: 'down' | 'slow' | null;
}

export interface DeadLettered {
  event: EventEnvelope;
  /** Reason code: the consumer's own for a handler rejection, the framework's (`INVALID_PAYLOAD`, ...) before it. */
  reason: string;
}

export interface SeededShop {
  shopId: string;
  name: string;
  slug: string;
  owner: TestUser;
}

type Agent = ReturnType<typeof supertest>;

export interface InsightsTestApp {
  app: INestApplication;
  clock: FakeClock;
  config: MockApiConfigService;
  baseUrl: string;
  faults: InsightsFaults;
  redis: Redis;
  http(): Agent;
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
  };
  newUser(): Promise<TestUser>;
  /** A real tenancy shop (membership gate) with its owner, announced to this capability like `tenancy.shop_created`. */
  seedShop(options?: {
    name?: string;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
    /** Do not tell this capability about the shop (no row in its name read model). */
    unannounced?: boolean;
  }): Promise<SeededShop>;
  /** A shop id known only to this capability's read model (no tenancy rows): enough for boards and counters. */
  readModelShop(
    name: string,
    shopId?: string,
  ): Promise<{ shopId: string; name: string; slug: string }>;
  /** Three real shops ordered by id (`A < B < C`), renamed Alpha, Beta, Gamma in the read model. */
  trio(): Promise<[SeededShop, SeededShop, SeededShop]>;
  member(shopId: string, role: ShopRole): Promise<TestUser>;
  /** A product of a shop with a category in this capability's product read model (`catalog.product_created`). */
  product(shopId: string, category: string): Promise<string>;
  // events
  paid(
    input: Omit<OrderPaidInput, 'orderId'> & { orderId?: string },
    meta?: { eventId?: string },
  ): EventEnvelope;
  reserved(
    input: { orderId?: string; shopIds: Array<string | null> },
    meta?: { occurredAt?: Date; eventId?: string },
  ): EventEnvelope;
  refunded(
    input: { orderId: string; amountMinor: number },
    meta?: { occurredAt?: Date },
  ): EventEnvelope;
  shopCreated(input: {
    shopId: string;
    name: string;
    slug: string;
    shopVersion: number;
  }): EventEnvelope;
  shopUpdated(input: {
    shopId: string;
    name: string;
    slug: string;
    shopVersion: number;
  }): EventEnvelope;
  shopDeleted(shopId: string): EventEnvelope;
  productEvent(
    kind: 'created' | 'updated' | 'archived' | 'restored',
    input: {
      productId: string;
      shopId: string;
      category: string;
      productVersion: number;
    },
  ): EventEnvelope;
  productDeleted(input: {
    productId: string;
    shopId: string;
    productVersion: number;
  }): EventEnvelope;
  /** An envelope exactly as the log would carry it, valid or not. */
  raw(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    meta?: { version?: number; eventId?: string; occurredAt?: Date | string },
  ): EventEnvelope;
  // delivery
  projector<T extends Projector>(type: { prototype: T }): T;
  /** Hands events to a consumer as the S53 runner does: route, project as a batch, then one by one up to the attempt budget. */
  deliver(
    projector: Projector,
    events: EventEnvelope[],
  ): Promise<{ deadLettered: DeadLettered[] }>;
  /** Delivers to the three order consumers (boards, live counters, sales history). */
  deliverOrders(events: EventEnvelope[]): Promise<void>;
  /** A raw read of this capability's PostgreSQL tables (assertions on persisted state). */
  pg<T extends object>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  // periods and snapshots
  week(id?: string): Period;
  month(id?: string): Period;
  freeze(periodId: string): Promise<SnapshotResult>;
  runSnapshotJob(kind: 'week' | 'month'): Promise<SnapshotResult[]>;
  snapshotRows(
    periodId: string,
    board?: string,
  ): Promise<
    Array<{
      rank: number;
      shopId: string;
      shopName: string | null;
      revenue: number;
      participants: number;
    }>
  >;
  // live dashboard
  ticker: DashboardTicker;
  extraTicker(instanceId: string): DashboardTicker;
  counters(): LiveCounterRepository;
  /** Opens the stream of `shop:<shopId>:live`; resolves after `count` events or `timeoutMs`. */
  subscribe(
    user: TestUser,
    shopId: string,
    options: { count: number; timeoutMs?: number },
  ): Promise<SseResult>;
  /** Waits until the hub reports a subscriber on the shop's live topic. */
  waitForSubscriber(shopId: string, timeoutMs?: number): Promise<void>;
  publisher: RealtimePublisher;
  // analytics store
  sql<T extends Record<string, unknown>>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<T[]>;
  forceCompaction(): Promise<void>;
  emptyAnalytics(): Promise<void>;
  // observation
  metrics: {
    board(outcome: Parameters<typeof insightsMetrics.value.board>[0]): number;
    live(outcome: Parameters<typeof insightsMetrics.value.live>[0]): number;
    deadLetter(feed: string, reason: string): number;
    ticksSkipped(): number;
    frames(): number;
    rateLimitDegraded(): number;
  };
  /** Structured lines the domain logged since `reset()` (parsed JSON). */
  logs(): Array<{ level: string; line: Record<string, unknown> }>;
  /** Every key under `lb:*` with its remaining TTL in ms (-1 = none). Test-only enumeration with SCAN. */
  boardKeys(): Promise<Array<{ key: string; ttlMs: number }>>;
  /** Members of a board with their revenue, best first. */
  board(
    period: Period,
    board?: string,
  ): Promise<Array<{ shopId: string; revenueMinor: number }>>;
  flushRedisPrefix(prefix: string): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Redis client that fails on demand (a store that is down, or a script that is rejected once). */
function faultableRedis(client: Redis, faults: InsightsFaults): Redis {
  const check = (command: string, args: unknown[]) => {
    if (faults.redisDown) throw new Error('redis down (injected)');
    const armed = faults.redisFail;
    if (armed && armed.match(command, args)) {
      if (--armed.times <= 0) faults.redisFail = null;
      throw new Error('redis command rejected (injected)');
    }
  };
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'pipeline')
        return (...args: unknown[]) => {
          const pipeline = (value as (...a: unknown[]) => any).apply(
            target,
            args,
          );
          const exec = pipeline.exec.bind(pipeline);
          pipeline.exec = () => {
            try {
              check('pipeline', []);
            } catch (error) {
              return Promise.reject(error as Error);
            }
            return exec();
          };
          return pipeline;
        };
      return (...args: unknown[]) => {
        try {
          check(String(prop), args);
        } catch (error) {
          return Promise.reject(error as Error);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function createInsightsApp(
  options: { env?: Record<string, string>; extraImports?: unknown[] } = {},
): Promise<InsightsTestApp> {
  const env = options.env ?? {};
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);

  const faults: InsightsFaults = {
    redisDown: false,
    redisFail: null,
    analytics: null,
  };
  const clock = new FakeClock(T0);
  const logLines: Array<{ level: string; line: Record<string, unknown> }> = [];
  const capture = (level: string) =>
    jest
      .spyOn(Logger.prototype, level as 'warn')
      .mockImplementation((message: unknown) => {
        if (typeof message !== 'string' || !message.startsWith('{')) return;
        try {
          logLines.push({ level, line: JSON.parse(message) });
        } catch {
          // not one of ours
        }
      });
  const spies = [capture('warn'), capture('log'), capture('error')];

  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        SeedsModule,
        RealtimeStreamModule,
        IdentityTopicsModule,
        ShopTopicsModule,
        LeaderboardsModule,
        SellerStatsModule,
        LeaderboardsWorkerModule,
        SellerInsightsProjectorModule,
        ...(options.extraImports ?? []),
      ],
      {
        stores: ['redis'],
        customize: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(TimeSource)
            .useValue({ overrideMs: () => clock.nowMs() })
            .overrideProvider(DASHBOARD_TICKER_OPTIONS)
            .useValue({ autoStart: false })
            .overrideProvider(INSIGHTS_REDIS)
            .useFactory({
              factory: (redis: RedisService) =>
                faultableRedis(redis.client, faults),
              inject: [RedisService],
            })
            .overrideProvider(INSIGHTS_CLICKHOUSE)
            .useFactory({
              factory: (clickhouse: ClickHouseService) => ({
                getClient: () => clickhouse.getClient(),
                async insert(...args: Parameters<ClickHouseService['insert']>) {
                  await guardAnalytics(args[2]?.timeoutMs);
                  return clickhouse.insert(...args);
                },
                async query(
                  sql: string,
                  params?: Record<string, unknown>,
                  opts?: { timeoutMs?: number },
                ) {
                  await guardAnalytics(opts?.timeoutMs);
                  return clickhouse.query(sql, params, opts);
                },
              }),
              inject: [ClickHouseService],
            }),
      },
    );
    app = moduleRef.createNestApplication({ bufferLogs: false });
    // a spec chooses the client address with X-Forwarded-For (the limiter counts per address)
    (app.get(ApiConfigService) as unknown as MockApiConfigService).set(
      'trusted_proxies',
      '127.0.0.0/8,::1',
    );
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  async function guardAnalytics(timeoutMs = 3_000): Promise<void> {
    if (faults.analytics === 'down')
      throw new Error('connect ECONNREFUSED (injected)');
    if (faults.analytics === 'slow') {
      await sleep(timeoutMs);
      throw new Error(
        `ClickHouse query timed out after ${timeoutMs} ms (injected stall)`,
      );
    }
  }

  const seeds = app.get(SeedsService);
  const config = app.get(ApiConfigService) as unknown as MockApiConfigService;
  const redisService = app.get(RedisService);
  const clickhouse = app.get(ClickHouseService);
  await applyClickHouseDdl(clickhouse, '051_shop_sale_facts.sql');
  const http = () => supertest(app.getHttpServer());
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  let counter = 0;
  const baseline = new Map<string, number>();

  const metricReaders: Record<string, () => number> = {};
  const outcomes = [
    'applied',
    'duplicate',
    'sealed',
    'rejected',
    'category_unresolved',
    'stale',
  ] as const;
  const liveOutcomes = [
    'applied',
    'duplicate',
    'stale',
    'shop_missing',
  ] as const;
  for (const o of outcomes)
    metricReaders[`board:${o}`] = () => insightsMetrics.value.board(o);
  for (const o of liveOutcomes)
    metricReaders[`live:${o}`] = () => insightsMetrics.value.live(o);
  metricReaders['ticks'] = () => insightsMetrics.value.ticksSkipped();
  metricReaders['frames'] = () => insightsMetrics.value.frames();
  metricReaders['degraded'] = () => insightsMetrics.value.rateLimitDegraded();
  const delta = (key: string) =>
    (metricReaders[key]?.() ?? 0) - (baseline.get(key) ?? 0);
  const deadLetterSeen = new Set<string>();
  const deadLetterBase = new Map<string, number>();

  const envelope = (
    type: string,
    aggregateType: string,
    aggregateId: string,
    aggregateVersion: number,
    schema: { parse(v: unknown): unknown },
    payload: unknown,
    meta: { eventId?: string; occurredAt?: Date } = {},
  ) =>
    eventEnvelopeSchema.parse({
      eventId: meta.eventId ?? uuidv7(),
      type,
      version: 1,
      aggregateType,
      aggregateId,
      aggregateVersion,
      occurredAt: (meta.occurredAt ?? clock.now()).toISOString(),
      payload: schema.parse(payload),
    }) as EventEnvelope;

  const productSnapshot = (input: {
    productId: string;
    shopId: string;
    category: string;
    productVersion: number;
  }) => {
    const now = clock.now().toISOString();
    return {
      productId: input.productId,
      shopId: input.shopId,
      title: 'Item',
      description: 'A fixture product',
      brand: 'Acme',
      category: input.category,
      priceMinor: 1000,
      currency: 'EUR',
      rating: 0,
      tags: [],
      quantity: 5,
      inStock: true,
      status: 'ACTIVE' as const,
      isSandbox: false,
      externalSku: null,
      productVersion: input.productVersion,
      createdAt: now,
      updatedAt: now,
      changedFields: [],
    };
  };

  const t: InsightsTestApp = {
    app,
    clock,
    config,
    baseUrl,
    faults,
    redis: redisService.client,
    http,
    as: (user) => ({
      get: (url) => http().get(url).set('Authorization', user.bearer),
    }),
    async newUser() {
      const user = await createUser(app, {
        email: `insights-${++counter}-${Date.now()}@example.com`,
      });
      const session = await issueSession(app, { id: user.id, role: user.role });
      return { id: user.id, email: user.email, bearer: session.bearer };
    },
    async seedShop(opts = {}) {
      const owner = await t.newUser();
      const name = opts.name ?? `Shop ${uuidv4().slice(0, 6)}`;
      const shop = await createShop(app, owner, { name, status: opts.status });
      if (!opts.unannounced)
        await t.deliver(t.projector(ShopNameProjectorRef()), [
          t.shopCreated({
            shopId: shop.id,
            name,
            slug: shop.slug,
            shopVersion: 1,
          }),
        ]);
      return { shopId: shop.id, name, slug: shop.slug, owner };
    },
    async readModelShop(name, id) {
      const shopId = id ?? uuidv4();
      const slug = `${name.toLowerCase().replace(/\W+/g, '-')}-${shopId.slice(0, 6)}`;
      await t.deliver(t.projector(ShopNameProjectorRef()), [
        t.shopCreated({ shopId, name, slug, shopVersion: 1 }),
      ]);
      return { shopId, name, slug };
    },
    async trio() {
      const shops = (
        await Promise.all([t.seedShop(), t.seedShop(), t.seedShop()])
      ).sort((x, y) => (x.shopId < y.shopId ? -1 : 1));
      const names = ['Alpha', 'Beta', 'Gamma'];
      await t.deliver(
        t.projector(ShopNameProjector),
        shops.map((s, i) =>
          t.shopUpdated({
            shopId: s.shopId,
            name: names[i],
            slug: names[i].toLowerCase(),
            shopVersion: 2,
          }),
        ),
      );
      return shops.map((s, i) => ({
        ...s,
        name: names[i],
        slug: names[i].toLowerCase(),
      })) as [SeededShop, SeededShop, SeededShop];
    },
    async member(shopId, role) {
      const user = await t.newUser();
      await addMember(app, shopId, user.id, role, 'invite');
      return user;
    },
    async product(shopId, category) {
      const productId = uuidv4();
      await t.deliver(t.projector(ProductProjectorRef()), [
        t.productEvent('created', {
          productId,
          shopId,
          category,
          productVersion: 1,
        }),
      ]);
      return productId;
    },
    paid(input, meta) {
      const orderId = input.orderId ?? uuidv4();
      return orderPaidEnvelope({ ...input, orderId }, meta) as EventEnvelope;
    },
    reserved(input, meta) {
      return orderReservedEnvelope(
        { orderId: input.orderId ?? uuidv4(), shopIds: input.shopIds },
        { occurredAt: clock.now(), ...meta },
      ) as EventEnvelope;
    },
    refunded: (input, meta) =>
      orderRefundedEnvelope(input, {
        occurredAt: clock.now(),
        ...meta,
      }) as EventEnvelope,
    shopCreated: (input) =>
      shopCreatedEnvelope(input, { occurredAt: clock.now() }) as EventEnvelope,
    shopUpdated: (input) =>
      shopUpdatedEnvelope(input, { occurredAt: clock.now() }) as EventEnvelope,
    shopDeleted: (shopId) =>
      shopDeletedEnvelope(
        { shopId },
        { occurredAt: clock.now() },
      ) as EventEnvelope,
    productEvent(kind, input) {
      return envelope(
        `catalog.product_${kind}`,
        'products',
        input.productId,
        input.productVersion,
        productSnapshotSchema,
        productSnapshot(input),
      );
    },
    productDeleted: (input) =>
      envelope(
        'catalog.product_deleted',
        'products',
        input.productId,
        input.productVersion,
        productDeletedPayloadSchema,
        input,
      ),
    raw: (type, aggregateType, aggregateId, payload, meta = {}) =>
      consumedEnvelope(type, aggregateType, aggregateId, payload, {
        occurredAt: clock.now(),
        ...meta,
      }) as EventEnvelope,
    projector: (type) => app.get(type as never, { strict: false }),
    async deliver(projector, events) {
      const deadLettered: DeadLettered[] = [];
      const routed: EventEnvelope[] = [];
      for (const event of events) {
        const r = routeEnvelope(
          projector.handles,
          event,
          projector.aggregateIdSchema,
        );
        if (r.kind === 'reject') deadLettered.push({ event, reason: r.code });
        else if (r.kind === 'handle') routed.push(r.envelope);
      }
      if (routed.length === 0) return { deadLettered };
      const budget = projector.attempts ?? 3;
      try {
        await projector.project(routed);
      } catch (error) {
        if (error instanceof TransientError) throw error;
        // a permanent failure of the chunk is the first attempt of every event in it, then they are tried one at a time
        for (const event of routed) {
          let used = 1;
          let last: unknown = error;
          for (;;) {
            if (used >= budget) {
              deadLettered.push({ event, reason: (last as Error).name });
              break;
            }
            try {
              await projector.project([event]);
              break;
            } catch (again) {
              if (again instanceof TransientError) throw again;
              used++;
              last = again;
            }
          }
        }
      }
      return { deadLettered };
    },
    async deliverOrders(events) {
      for (const consumer of OrderConsumers())
        await t.deliver(t.projector<Projector>(consumer), events);
    },
    week: (id) => (id ? parseWeek(id) : periodOf('week', clock.now())),
    month: (id) => (id ? parseMonth(id) : periodOf('month', clock.now())),
    freeze: (periodId) => app.get(SnapshotService).freeze(periodId),
    runSnapshotJob: (kind) => app.get(SnapshotJobs).snapshot({ kind }),
    pg(query, replacements) {
      return app
        .get<Sequelize>(getConnectionToken(), { strict: false })
        .query(query, { type: QueryTypes.SELECT, replacements }) as never;
    },
    async snapshotRows(periodId, board = 'all') {
      const rows = await t.pg<{
        rank: number;
        shopId: string;
        shopName: string | null;
        revenue: string;
        participants: number;
      }>(
        `SELECT "rank", "shopId", "shopName", "revenue"::text AS "revenue", "participants" FROM "LeaderboardSnapshot"
         WHERE "period" = :periodId AND "board" = :board ORDER BY "rank"`,
        { periodId, board },
      );
      return rows.map((r) => ({ ...r, revenue: Number(r.revenue) }));
    },
    ticker: app.get(DashboardTicker),
    extraTicker: (instanceId) =>
      new DashboardTicker(
        app.get(RealtimeSubscriptions),
        app.get(RealtimePublisher),
        app.get(LIVE_COUNTER_REPOSITORY),
        app.get(INSIGHTS_REDIS),
        clock,
        { autoStart: false, instanceId },
      ),
    counters: () => app.get(LIVE_COUNTER_REPOSITORY),
    subscribe: (user, shopId, opts) =>
      readSse(`${baseUrl}/streams?topics=shop:${shopId}:live`, {
        headers: { Authorization: user.bearer },
        count: opts.count,
        timeoutMs: opts.timeoutMs ?? 10_000,
      }),
    async waitForSubscriber(shopId, timeoutMs = 5_000) {
      const subscriptions = app.get(RealtimeSubscriptions);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (
          (await subscriptions.topicsWithSubscribers('shop', 'live')).includes(
            `shop:${shopId}:live`,
          )
        )
          return;
        await sleep(25);
      }
      throw new Error(
        `no subscriber on shop:${shopId}:live within ${timeoutMs} ms`,
      );
    },
    publisher: app.get(RealtimePublisher),
    async sql(query, params) {
      return (await (
        await clickhouse
          .getClient()
          .query({ query, query_params: params, format: 'JSONEachRow' })
      ).json()) as never;
    },
    async forceCompaction() {
      for (const table of ['shop_sale_facts', 'shop_refund_facts'])
        await clickhouse
          .getClient()
          .command({ query: `OPTIMIZE TABLE ${table} FINAL` });
    },
    async emptyAnalytics() {
      for (const table of ['shop_sale_facts', 'shop_refund_facts'])
        await clickhouse
          .getClient()
          .command({ query: `TRUNCATE TABLE ${table}` });
    },
    metrics: {
      board: (o) => delta(`board:${o}`),
      live: (o) => delta(`live:${o}`),
      deadLetter: (feed, reason) =>
        insightsMetrics.value.deadLetter(feed, reason) -
        (deadLetterBase.get(`${feed}:${reason}`) ?? 0),
      ticksSkipped: () => delta('ticks'),
      frames: () => delta('frames'),
      rateLimitDegraded: () => delta('degraded'),
    },
    logs: () => [...logLines],
    async boardKeys() {
      const out: Array<{ key: string; ttlMs: number }> = [];
      let cursor = '0';
      do {
        const [next, keys] = await redisService.client.scan(
          cursor,
          'MATCH',
          'lb:*',
          'COUNT',
          500,
        );
        cursor = next;
        for (const key of keys)
          out.push({ key, ttlMs: await redisService.client.pttl(key) });
      } while (cursor !== '0');
      return out;
    },
    async board(period, board = 'all') {
      const flat = await redisService.client.zrevrange(
        `lb:{${period.id}}:z:${board}`,
        0,
        -1,
        'WITHSCORES',
      );
      const out: Array<{ shopId: string; revenueMinor: number }> = [];
      for (let i = 0; i < flat.length; i += 2)
        out.push({
          shopId: flat[i],
          revenueMinor: Math.floor(Number(flat[i + 1]) / 2 ** 20),
        });
      return out;
    },
    async flushRedisPrefix(prefix) {
      let cursor = '0';
      do {
        const [next, keys] = await redisService.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          500,
        );
        cursor = next;
        if (keys.length) await redisService.client.del(...keys);
      } while (cursor !== '0');
    },
    async reset() {
      Object.assign(faults, {
        redisDown: false,
        redisFail: null,
        analytics: null,
      });
      clock.set(T0);
      await seeds.clean();
      await t.emptyAnalytics();
      app.get(KeyStore).invalidate();
      config.reset();
      logLines.length = 0;
      for (const [key, read] of Object.entries(metricReaders))
        baseline.set(key, read());
      deadLetterSeen.clear();
      for (const feed of [
        'boards',
        'live',
        'sales',
        'refunds',
        'shops',
        'products',
        'erasure',
      ])
        for (const reason of [
          'invalid_payload',
          'unsupported_currency',
          'revenue_limit_exceeded',
          'partial_refund_unsupported',
          'refund_without_sale',
        ])
          deadLetterBase.set(
            `${feed}:${reason}`,
            insightsMetrics.value.deadLetter(feed, reason),
          );
    },
    async close() {
      for (const spy of spies) spy.mockRestore();
      await app.close();
    },
  };

  return t;
}

const ShopNameProjectorRef = () => ShopNameProjector;
const ProductProjectorRef = () => ProductCategoryProjector;
const OrderConsumers = () => [BoardProjector, LiveProjector, SalesProjector];

const parseWeek = (id: string): Period => {
  const [year, week] = id.split('-W').map(Number);
  // the Monday of ISO week 1 is the Monday on or before January 4th
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(
    jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000,
  );
  return periodOf(
    'week',
    new Date(monday.getTime() + (week - 1) * 7 * 86_400_000),
  );
};
const parseMonth = (id: string): Period => {
  const [year, month] = id.split('-').map(Number);
  return periodOf('month', new Date(Date.UTC(year, month - 1, 1)));
};

export type { PaidLineInput };
