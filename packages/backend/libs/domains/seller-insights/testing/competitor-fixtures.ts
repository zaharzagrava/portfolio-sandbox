import { Global, Logger, Module, type INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type Redis from 'ioredis';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import {
  consumedEnvelope,
  productDeletedPayloadSchema,
  shopDeletedEnvelope,
  shopPlanChangedEnvelope,
  shopStatusChangedEnvelope,
} from '@marketplace-sandbox/contracts';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import {
  outboxRowsFor,
  type OutboxRowView,
} from '@app/common/testing/outbox-rows';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { TransientError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { AuthApiModule, IdentityTopicsModule } from '@app/domains/identity';
import { ShopTopicsModule } from '@app/domains/tenancy';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import {
  clearShopSubscriptions,
  installCompetitorWatchLimits,
  removeCompetitorWatchLimits,
  setShopWatchLimit,
} from '@app/test/utils/billing-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { CompetitorEvaluationService } from '../application/competitor-evaluation.service';
import { CrawlRetentionService } from '../application/crawl-retention.service';
import { CrawlSchedulerService } from '../application/crawl-scheduler.service';
import { CrawlService } from '../application/crawl.service';
import { CompetitorShopService } from '../application/competitor-shop.service';
import { crawlerMetrics } from '../application/crawler.metrics';
import { CompetitorWatchService } from '../application/competitor-watch.service';
import { CrawlerConfig } from '../application/crawler.config';
import {
  FRONTIER,
  PAGE_ARCHIVE,
  TARGET_REPOSITORY,
  type FrontierPort,
  type PageArchive,
  type TargetRepository,
} from '../domain/crawler-ports';
import { CompetitorProjectorModule } from '../competitor-projector.module';
import { CompetitorsModule } from '../competitors.module';
import { CrawlerWorkerModule } from '../crawler-worker.module';
import { COMPETITOR_CLICKHOUSE } from '../infra/clickhouse-observation-history';
import { CRAWLER_WORKER_OPTIONS, CrawlerWorker } from '../infra/crawler.worker';
import {
  CompetitorProductProjector,
  CompetitorShopProjector,
} from '../infra/projectors/competitor.projectors';
import { CRAWLER_REDIS, CRAWLER_WALL_CLOCK } from '../infra/redis-frontier';
import { SAFE_FETCH_SEAM } from '../infra/safe-fetcher';
import { S3PageArchive } from '../infra/s3-page-archive';
import { CompetitorSite } from './competitor-site';

/** The frozen "now" of the S41 scenarios. */
export const T0 = new Date('2026-10-06T12:00:00.000Z');

export const HOSTS = {
  'rival.test': '93.184.216.34',
  'other.test': '93.184.216.35',
  'a.test': '93.184.216.36',
  'b.test': '93.184.216.37',
  'c.test': '93.184.216.38',
} as const;
export type SiteHost = keyof typeof HOSTS;

export interface TestUser {
  id: string;
  email: string;
  /** `Bearer <access token>` */
  bearer: string;
}
export type ShopRole = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';
export interface SeededShop {
  shopId: string;
  owner: TestUser;
}

/** Switchable failures at the store edges (all off after `reset()`). */
export interface CompetitorFaults {
  /** Price history inserts and reads fail. */
  history: boolean;
  /** Archiving a page fails. */
  archive: boolean;
  /** Every command on the crawler's Redis client fails. */
  redisDown: boolean;
}

export interface DeadLettered {
  event: EventEnvelope;
  reason: string;
}

type Agent = ReturnType<typeof supertest>;

/** Names resolve to addresses the stand-ins are mapped to; a spec can re-point a name or flip it after N lookups. */
export class FixtureNet {
  private readonly table = new Map<string, string[]>();
  private readonly flips = new Map<
    string,
    { after: number; later: string[]; seen: number }
  >();
  lookups: string[] = [];

  constructor(private readonly sites: () => CompetitorSite[]) {
    this.resetTable();
  }

  resetTable() {
    this.table.clear();
    this.flips.clear();
    this.lookups = [];
    for (const [host, address] of Object.entries(HOSTS))
      this.table.set(host, [address]);
  }

  /** `names` resolve to `addresses` from now on. */
  set(host: string, ...addresses: string[]) {
    this.table.set(host, addresses);
    this.flips.delete(host);
  }
  unset(host: string) {
    this.table.delete(host);
  }
  /** The first `after` lookups of `host` answer as before, every later one answers `later`. */
  flipAfter(host: string, after: number, ...later: string[]) {
    this.flips.set(host, { after, later, seen: 0 });
  }

  readonly resolver = (host: string) => {
    this.lookups.push(host);
    const flip = this.flips.get(host);
    let addresses = this.table.get(host);
    if (flip) {
      flip.seen++;
      if (flip.seen > flip.after) addresses = flip.later;
    }
    if (!addresses)
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
        }),
      );
    return Promise.resolve(
      addresses.map((address) => ({
        address,
        family: (address.includes(':') ? 6 : 4) as 4 | 6,
      })),
    );
  };

  get transport() {
    const sites = this.sites();
    return {
      ca: sites.map((s) => s.ca).join('\n'),
      mapAddress: (address: string, port: number) => {
        const site = sites.find((s) => s.address === address);
        return site
          ? { address: '127.0.0.1', port: site.port }
          : { address, port };
      },
    };
  }
}

export interface CompetitorTestApp {
  app: INestApplication;
  clock: FakeClock;
  config: MockApiConfigService;
  baseUrl: string;
  faults: CompetitorFaults;
  redis: Redis;
  net: FixtureNet;
  sites: Record<SiteHost, CompetitorSite>;
  http(): Agent;
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    delete(url: string): ReturnType<Agent['delete']>;
  };
  newUser(): Promise<TestUser>;
  /** A fresh session for the user at the clock's current time (access tokens last 5 minutes of that clock). */
  reauth(user: TestUser): Promise<TestUser>;
  /** A real tenancy shop with its owner; announced to this capability like `tenancy.shop_created` when `announce`. */
  seedShop(options?: {
    name?: string;
    plan?: 'STARTER' | 'PRO' | 'ENTERPRISE';
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
    /** `maxCompetitorWatches` of the shop (a subscription is written); none means the free tier (0). */
    limit?: number;
    announce?: boolean;
  }): Promise<SeededShop>;
  member(shopId: string, role: ShopRole): Promise<TestUser>;
  /** `maxCompetitorWatches` of a shop from now on (billing basis row + cache drop). */
  limit(shopId: string, limit: number): Promise<void>;
  product(
    shopId: string,
    options?: {
      priceMinor?: number;
      currency?: string;
      title?: string;
      status?: 'ACTIVE' | 'ARCHIVED';
    },
  ): Promise<{ id: string; priceMinor: number }>;
  /** Adds a second owner to a shop. */
  owner(shopId: string): Promise<TestUser>;
  // routes
  watch(
    user: TestUser,
    shopId: string,
    productId: string,
    url: string,
  ): ReturnType<Agent['post']>;
  /** Registers and expects `201` or `200`; returns the watch. */
  register(
    user: TestUser,
    shopId: string,
    productId: string,
    url: string,
  ): Promise<{ id: string; created: boolean; body: Record<string, unknown> }>;
  // services
  watches: CompetitorWatchService;
  crawl: CrawlService;
  scheduler: CrawlSchedulerService;
  retention: CrawlRetentionService;
  evaluation: CompetitorEvaluationService;
  shopService: CompetitorShopService;
  worker: CrawlerWorker;
  frontier: FrontierPort;
  targets: TargetRepository;
  config_: CrawlerConfig;
  /** A further worker instance on the same stores (the fleet), with its own fetch loops. */
  extraWorker(loops: number): CrawlerWorker;
  // driving the crawl
  advance(ms: number): void;
  /** The crawler's politeness clock (real time plus what `skipGaps` has skipped). */
  wallNow(): number;
  /** Makes every host's politeness gap pass without waiting (a spec about the gap itself does not call this). */
  skipGaps(): void;
  schedule(limit?: number): Promise<number>;
  /** Crawls every queued target; waits out politeness gaps unless `skipGaps`. */
  drain(options?: { skipGaps?: boolean; timeoutMs?: number }): Promise<number>;
  /** schedule + drain. */
  cycle(options?: { skipGaps?: boolean; limit?: number }): Promise<void>;
  // state
  pg<T extends object>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  target(url: string): Promise<TargetRow | undefined>;
  watchRows(shopId?: string): Promise<WatchRow[]>;
  outbox(watchId: string): Promise<OutboxRowView[]>;
  alerts(watchId: string): Promise<OutboxRowView[]>;
  history(targetId: string): Promise<
    Array<{
      ts: string;
      price_minor: number;
      currency: string;
      observation_no: number;
    }>
  >;
  archived(): Promise<Array<{ key: string; size: number }>>;
  keys(pattern: string): Promise<Array<{ key: string; ttlMs: number }>>;
  logs(): Array<{ level: string; line: Record<string, unknown> }>;
  /** Process-wide counters: read before and after to get a delta. */
  metrics: typeof crawlerMetrics.value;
  // events
  shopCreated(input: {
    shopId: string;
    plan?: string;
    shopVersion?: number;
  }): EventEnvelope;
  shopPlanChanged(input: {
    shopId: string;
    plan: string;
    shopVersion: number;
  }): EventEnvelope;
  shopStatusChanged(input: {
    shopId: string;
    to: string;
    shopVersion: number;
  }): EventEnvelope;
  shopDeleted(shopId: string): EventEnvelope;
  productDeleted(input: {
    productId: string;
    shopId: string;
    productVersion?: number;
  }): EventEnvelope;
  raw(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    meta?: { version?: number; eventId?: string },
  ): EventEnvelope;
  projector<T extends Projector>(type: { prototype: T }): T;
  deliver(
    projector: Projector,
    events: EventEnvelope[],
  ): Promise<{ deadLettered: DeadLettered[] }>;
  /** A DB trigger that makes every competitor price drop outbox insert fail; `false` removes it. */
  failOutbox(on: boolean): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TargetRow {
  id: string;
  url: string;
  host: string;
  lastPriceMinor: string | null;
  currency: string | null;
  simhash: string | null;
  unchangedStreak: number;
  lastStatus: string | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  observationNo: number;
  evaluatedNo: number;
  noPriceStreak: number;
  errorStreak: number;
  retiredAt: Date | null;
}
export interface WatchRow {
  id: string;
  shopId: string;
  productId: string;
  targetId: string;
  status: string;
  createdAt: Date;
  lastEvaluatedObservationNo: number;
  lastEvaluatedPriceMinor: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Redis client that fails on demand (a store that is down). */
function faultableRedis(client: Redis, faults: CompetitorFaults): Redis {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (faults.redisDown)
          return Promise.reject(new Error('redis down (injected)'));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export async function createCompetitorApp(
  options: { env?: Record<string, string>; sites?: SiteHost[] } = {},
): Promise<CompetitorTestApp> {
  const env = options.env ?? {};
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);

  const faults: CompetitorFaults = {
    history: false,
    archive: false,
    redisDown: false,
  };
  const clock = new FakeClock(T0);
  let wallOffset = 0;
  const sites = Object.fromEntries(
    await Promise.all(
      (options.sites ?? (Object.keys(HOSTS) as SiteHost[])).map(
        async (host) =>
          [host, await CompetitorSite.start(host, HOSTS[host])] as const,
      ),
    ),
  ) as Record<SiteHost, CompetitorSite>;
  const net = new FixtureNet(() => Object.values(sites));

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

  @Global()
  @Module({
    providers: [
      {
        provide: SAFE_FETCH_SEAM,
        useFactory: () => ({
          resolver: net.resolver,
          get testTransport() {
            return net.transport;
          },
        }),
      },
    ],
    exports: [SAFE_FETCH_SEAM],
  })
  class FixtureSeamModule {}

  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        SeedsModule,
        IdentityTopicsModule,
        ShopTopicsModule,
        FixtureSeamModule,
        CompetitorsModule,
        CrawlerWorkerModule,
        CompetitorProjectorModule,
      ],
      {
        stores: ['redis'],
        customize: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(TimeSource)
            .useValue({ overrideMs: () => clock.nowMs() })
            .overrideProvider(CRAWLER_WORKER_OPTIONS)
            .useValue({ autoStart: false })
            .overrideProvider(CRAWLER_WALL_CLOCK)
            .useValue(() => Date.now() + wallOffset)
            .overrideProvider(CRAWLER_REDIS)
            .useFactory({
              factory: (redis: RedisService) =>
                faultableRedis(redis.client, faults),
              inject: [RedisService],
            })
            .overrideProvider(COMPETITOR_CLICKHOUSE)
            .useFactory({
              factory: (clickhouse: ClickHouseService) => ({
                getClient: () => {
                  if (faults.history)
                    throw new Error('connect ECONNREFUSED (injected)');
                  return clickhouse.getClient();
                },
                async query(...args: Parameters<ClickHouseService['query']>) {
                  if (faults.history)
                    throw new Error('connect ECONNREFUSED (injected)');
                  return clickhouse.query(...args);
                },
              }),
              inject: [ClickHouseService],
            })
            .overrideProvider(PAGE_ARCHIVE)
            .useFactory({
              factory: (real: S3PageArchive): PageArchive => ({
                put: async (key, html) => {
                  if (faults.archive)
                    throw new Error('storage unavailable (injected)');
                  return real.put(key, html);
                },
                ensureLifecycle: () => real.ensureLifecycle(),
              }),
              inject: [S3PageArchive],
            }),
      },
    );
    app = moduleRef.createNestApplication({ bufferLogs: false });
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

  const seeds = app.get(SeedsService);
  const config = app.get(ApiConfigService) as unknown as MockApiConfigService;
  const redisService = app.get(RedisService);
  const clickhouse = app.get(ClickHouseService);
  const sequelize = app.get<Sequelize>(getConnectionToken(), { strict: false });
  await applyClickHouseDdl(
    clickhouse,
    '090_competitor_prices.sql',
    '131_competitor_prices_v2.sql',
  );
  const http = () => supertest(app.getHttpServer());
  const port = (app.getHttpServer().address() as AddressInfo).port;
  let counter = 0;
  const frontier = app.get<FrontierPort>(FRONTIER, { strict: false });
  const targets = app.get<TargetRepository>(TARGET_REPOSITORY, {
    strict: false,
  });
  const crawl = app.get(CrawlService, { strict: false });
  const scheduler = app.get(CrawlSchedulerService, { strict: false });
  const worker = app.get(CrawlerWorker, { strict: false });

  const envelope = (
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
    meta: {
      version?: number;
      eventId?: string;
      aggregateVersion?: number;
    } = {},
  ) =>
    consumedEnvelope(type, aggregateType, aggregateId, payload, {
      occurredAt: clock.now(),
      ...meta,
    }) as EventEnvelope;

  const pg = <T extends object>(
    query: string,
    replacements?: Record<string, unknown>,
  ) =>
    sequelize.query(query, {
      type: QueryTypes.SELECT,
      replacements,
    }) as Promise<T[]>;

  // the billing plans carry the limit while a spec runs (see the shared billing fixtures); taken off again at close
  await installCompetitorWatchLimits(app);

  const t: CompetitorTestApp = {
    app,
    clock,
    config,
    baseUrl: `http://127.0.0.1:${port}/api`,
    faults,
    redis: redisService.client,
    net,
    sites,
    http,
    as: (user) => ({
      get: (url) => http().get(url).set('Authorization', user.bearer),
      post: (url) => http().post(url).set('Authorization', user.bearer),
      delete: (url) => http().delete(url).set('Authorization', user.bearer),
    }),
    async newUser() {
      const user = await createUser(app, {
        email: `competitor-${++counter}-${Date.now()}@example.com`,
      });
      const session = await issueSession(app, { id: user.id, role: user.role });
      return { id: user.id, email: user.email, bearer: session.bearer };
    },
    async reauth(user) {
      const session = await issueSession(app, { id: user.id, role: 'USER' });
      return { ...user, bearer: session.bearer };
    },
    async seedShop(opts = {}) {
      const owner = await t.newUser();
      const shop = await createShop(app, owner, {
        name: opts.name ?? `Shop ${uuidv4().slice(0, 6)}`,
        plan: opts.plan,
        status: opts.status,
      });
      if (opts.limit !== undefined) await t.limit(shop.id, opts.limit);
      if (opts.announce) {
        await t.deliver(t.projector(CompetitorShopProjector), [
          t.shopCreated({ shopId: shop.id, plan: opts.plan ?? 'STARTER' }),
        ]);
        if (opts.status && opts.status !== 'ACTIVE')
          await t.deliver(t.projector(CompetitorShopProjector), [
            t.shopStatusChanged({
              shopId: shop.id,
              to: opts.status,
              shopVersion: 2,
            }),
          ]);
      }
      return { shopId: shop.id, owner };
    },
    async member(shopId, role) {
      const user = await t.newUser();
      await addMember(app, shopId, user.id, role, 'invite');
      return user;
    },
    owner: async (shopId) => {
      const user = await t.newUser();
      await addMember(app, shopId, user.id, 'OWNER', 'invite');
      return user;
    },
    limit: (shopId, limit) => setShopWatchLimit(app, shopId, limit),
    async product(shopId, opts = {}) {
      const product = await createProduct(
        app,
        { id: shopId },
        {
          priceMinor: opts.priceMinor ?? 99_900,
          currency: opts.currency ?? 'EUR',
          title: opts.title ?? 'iPhone 17',
          status: opts.status,
        },
      );
      return { id: product.id, priceMinor: product.priceMinor };
    },
    watch: (user, shopId, productId, url) =>
      t
        .as(user)
        .post(`/api/shops/${shopId}/competitors`)
        .send({ productId, url }),
    async register(user, shopId, productId, url) {
      const res = await t.watch(user, shopId, productId, url);
      if (res.status !== 201 && res.status !== 200)
        throw new Error(
          `register answered ${res.status}: ${JSON.stringify(res.body)}`,
        );
      return { id: res.body.id, created: res.status === 201, body: res.body };
    },
    watches: app.get(CompetitorWatchService, { strict: false }),
    crawl,
    scheduler,
    retention: app.get(CrawlRetentionService, { strict: false }),
    evaluation: app.get(CompetitorEvaluationService, { strict: false }),
    shopService: app.get(CompetitorShopService, { strict: false }),
    worker,
    frontier,
    targets,
    config_: app.get(CrawlerConfig, { strict: false }),
    extraWorker(loops) {
      const base = worker as unknown as {
        crawl: CrawlService;
        scheduler: CrawlSchedulerService;
        retention: CrawlRetentionService;
        jobs: never;
        config: CrawlerConfig;
        archive: PageArchive;
        frontier: FrontierPort;
      };
      return new CrawlerWorker(
        base.crawl,
        base.scheduler,
        base.retention,
        base.jobs,
        base.config,
        base.archive,
        base.frontier,
        { autoStart: false, loops },
      );
    },
    advance: (ms) => clock.advance(ms),
    wallNow: () => Date.now() + wallOffset,
    skipGaps: () => {
      wallOffset += 3_600_000;
    },
    schedule: (limit) => scheduler.scheduleDue(limit),
    async drain(opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let crawled = 0;
      if (opts.skipGaps !== false) t.skipGaps();
      for (;;) {
        if (await crawl.crawlNext()) {
          crawled++;
          if (opts.skipGaps !== false) t.skipGaps();
          continue;
        }
        if ((await frontier.readyHosts()) === 0) return crawled;
        if (Date.now() > deadline)
          throw new Error(`drain timed out after ${crawled} crawls`);
        await sleep(50);
      }
    },
    async cycle(opts = {}) {
      await t.schedule(opts.limit);
      await t.drain({ skipGaps: opts.skipGaps });
    },
    pg,
    async target(url) {
      return (
        await pg<TargetRow>(`SELECT * FROM "CrawlTarget" WHERE "url" = :url`, {
          url,
        })
      )[0];
    },
    watchRows: (shopId) =>
      shopId
        ? pg<WatchRow>(
            `SELECT * FROM "CompetitorWatch" WHERE "shopId" = :shopId ORDER BY "createdAt", "id"`,
            { shopId },
          )
        : pg<WatchRow>(
            `SELECT * FROM "CompetitorWatch" ORDER BY "createdAt", "id"`,
          ),
    outbox: (watchId) => outboxRowsFor(app, watchId),
    async alerts(watchId) {
      return (await outboxRowsFor(app, watchId)).filter(
        (row) => row.type === 'sellerinsights.competitor_price_dropped',
      );
    },
    async history(targetId) {
      const rows = (await (
        await clickhouse.getClient().query({
          query: `SELECT toString(ts) AS ts, price_minor, currency, observation_no FROM competitor_prices
                  WHERE target_id = {targetId:String} ORDER BY ts, observation_no`,
          query_params: { targetId },
          format: 'JSONEachRow',
        })
      ).json()) as Array<{
        ts: string;
        price_minor: string;
        currency: string;
        observation_no: number;
      }>;
      return rows.map((r) => ({ ...r, price_minor: Number(r.price_minor) }));
    },
    async archived() {
      const objects = await app.get(ObjectStorage).list('crawl/');
      return objects.map(({ key, size }) => ({ key, size }));
    },
    async keys(pattern) {
      const out: Array<{ key: string; ttlMs: number }> = [];
      let cursor = '0';
      do {
        const [next, found] = await redisService.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          500,
        );
        cursor = next;
        for (const key of found)
          out.push({ key, ttlMs: await redisService.client.pttl(key) });
      } while (cursor !== '0');
      return out;
    },
    logs: () => [...logLines],
    metrics: crawlerMetrics.value,
    shopCreated: (input) =>
      envelope(
        'tenancy.shop_created',
        'tenancy',
        input.shopId,
        {
          shopId: input.shopId,
          ownerId: null,
          name: 'Shop',
          slug: 'shop',
          plan: input.plan ?? 'STARTER',
          region: 'eu-central-1',
          shopVersion: input.shopVersion ?? 1,
        },
        { aggregateVersion: input.shopVersion ?? 1 },
      ),
    shopPlanChanged: (input) =>
      shopPlanChangedEnvelope(input, {
        occurredAt: clock.now(),
      }) as EventEnvelope,
    shopStatusChanged: (input) =>
      shopStatusChangedEnvelope(input, {
        occurredAt: clock.now(),
      }) as EventEnvelope,
    shopDeleted: (shopId) =>
      shopDeletedEnvelope(
        { shopId },
        { occurredAt: clock.now() },
      ) as EventEnvelope,
    productDeleted: (input) =>
      envelope(
        'catalog.product_deleted',
        'products',
        input.productId,
        productDeletedPayloadSchema.parse({
          ...input,
          productVersion: input.productVersion ?? 7,
        }) as Record<string, unknown>,
        { aggregateVersion: input.productVersion ?? 7 },
      ),
    raw: (type, aggregateType, aggregateId, payload, meta = {}) =>
      envelope(type, aggregateType, aggregateId, payload, meta),
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
    async failOutbox(on) {
      await sequelize.query(
        `DROP TRIGGER IF EXISTS s41_fail_alert ON "Outbox"; DROP FUNCTION IF EXISTS s41_fail_alert()`,
      );
      if (!on) return;
      await sequelize.query(`
        CREATE FUNCTION s41_fail_alert() RETURNS trigger AS $$
        BEGIN
          IF NEW."type" = 'sellerinsights.competitor_price_dropped' THEN
            RAISE EXCEPTION 'outbox insert refused (injected)';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s41_fail_alert BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION s41_fail_alert();
      `);
    },
    async reset() {
      Object.assign(faults, {
        history: false,
        archive: false,
        redisDown: false,
      });
      await t.failOutbox(false);
      clock.set(T0);
      wallOffset = 0;
      // no jitter unless a spec asks for it: an interval is then exactly the ladder's
      crawl.random = () => 0.5;
      // the gap between a fresh robots.txt request and the page is real time only in the specs about politeness
      crawl.sleep = () => Promise.resolve();
      net.resetTable();
      for (const site of Object.values(sites)) site.reset();
      await seeds.clean();
      await clearShopSubscriptions(app);
      await sequelize.query(
        `DELETE FROM "CompetitorWatch"; DELETE FROM "CrawlTarget"; DELETE FROM "CompetitorShop";`,
      );
      await clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE competitor_prices' });
      await app.get(ObjectStorage).deletePrefix('crawl/', { limit: 10_000 });
      for (const entry of await t.keys('crawl:*'))
        await redisService.client.del(entry.key);
      config.reset();
      logLines.length = 0;
    },
    async close() {
      for (const spy of spies) spy.mockRestore();
      await t.failOutbox(false).catch(() => undefined);
      await worker.stop(1_000).catch(() => undefined);
      await removeCompetitorWatchLimits(app).catch(() => undefined);
      await app.close();
      await Promise.all(Object.values(sites).map((s) => s.close()));
    },
  };

  return t;
}

export type { OutboxRowView };
