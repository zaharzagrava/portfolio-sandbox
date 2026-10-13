import type { INestApplication } from '@nestjs/common';
import type { Client, types } from 'cassandra-driver';
import type Redis from 'ioredis';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import type { FakeClock } from '@app/common/core/clock';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { DiscussionsJobs } from '../infra/discussions.jobs';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { Role, UserDirectoryService } from '@app/domains/identity';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { DiscussionsModule } from '../discussions.module';
import { DiscussionsWorkerModule } from '../discussions-worker.module';
import { REDIS_CLIENT, SCYLLA_CLIENT } from '../domain/ports';
import { ReconcileService } from '../application/reconcile.service';
import { EventRelayService } from '../application/event-relay.service';

/** Switchable faults at the two driver edges and at the identity directory (S25 test-plan: faults at the edge). */
export interface Faults {
  /** Every ScyllaDB call fails (as a timeout would). */
  scyllaDown: boolean;
  /**
   * The next `times` ScyllaDB calls whose CQL text contains `match` fail as a timeout would. With `after`, the call
   * is executed first and the answer is lost (the write lands, the caller sees a failure).
   */
  scyllaFail: { match: string; times: number; after?: boolean } | null;
  /** Every Redis call of discussions fails. */
  redisDown: boolean;
  /** The identity directory throws. */
  directoryDown: boolean;
  /** The event bus refuses publishes. */
  busDown: boolean;
}

export interface PublishedEvent {
  eventId: string;
  type: string;
  aggregateId: string;
  payload: Record<string, any>;
}

export interface DiscussionsTestApp extends CatalogTestApp {
  redisProxy: TcpFaultProxy | null;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
  logs(): Array<Record<string, any>>;
  clearLogs(): void;
  faults: Faults;
  config: MockApiConfigService;
  /** Events the (spied) bus accepted, in order; duplicates are kept. */
  published: PublishedEvent[];
  /** Rows returned by ScyllaDB `SELECT`s since the last `resetRowCounts()`, per table. */
  rowsRead: Map<string, number>;
  resetRowCounts(): void;
  sql<T extends object = Record<string, unknown>>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  /** Raw ScyllaDB access for assertions and for seeding old data at the store edge. */
  cql(query: string, params?: unknown[]): Promise<types.ResultSet>;
  redis: Redis;
  /** A user whose account was created `ageHours` ago (default 30 days): its votes weigh 1. */
  agedUser(options?: { role?: Role; ageHours?: number }): Promise<TestUser>;
  users(n: number, options?: { aged?: boolean }): Promise<TestUser[]>;
  world(): Promise<{
    shopId: string;
    product: SeededProduct;
    archived: SeededProduct;
    author: TestUser;
    reader: TestUser;
    moderator: TestUser;
    seller: TestUser;
  }>;
  product(seed?: { status?: 'ACTIVE' | 'ARCHIVED' }): Promise<SeededProduct>;
  /** Runs a registered job handler by its type, as the jobs worker would. */
  runJob(type: string, payload?: Record<string, unknown>): Promise<void>;
  /** Run the relay once over everything in the queue (the worker's job body). */
  relay(): Promise<{ published: number; failed: number; dead: number }>;
  /** Flush buffered vote deltas and reconcile the recent targets (the worker's job body). */
  reconcile(): ReturnType<ReconcileService['reconcile']>;
  /** The Redis keys of discussions (`dsc:*`) with their remaining TTL (seconds, -1 = none). */
  cacheKeys(): Promise<Array<{ key: string; ttl: number }>>;
  /** Forget every `dsc:*` key (a cache flush). */
  flushDiscussionCache(): Promise<void>;
  post(
    user: TestUser,
    productId: string,
    body?: { title?: string; body?: string },
    key?: string,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  comment(
    user: TestUser,
    postId: string,
    body: { body?: string; parentId?: string },
    key?: string,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  vote(
    user: TestUser,
    targetId: string,
    value: unknown,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['put']>;
  /** Creates a post and returns its id (throws unless 201). */
  newPost(
    user: TestUser,
    productId: string,
    over?: { title?: string; body?: string },
  ): Promise<string>;
  newComment(
    user: TestUser,
    postId: string,
    over?: { body?: string; parentId?: string },
  ): Promise<string>;
}

const TABLE = /\bFROM\s+([a-z_]+)/i;

/** A proxy over the ScyllaDB driver client: fails on demand and counts the rows each table returned. */
function faultableCassandra(
  client: Client,
  faults: Faults,
  counts: Map<string, number>,
): Client {
  /** `'before'`: fail without executing; `'after'`: execute, then fail; `null`: pass. */
  const decide = (query: unknown): 'before' | 'after' | null => {
    if (faults.scyllaDown) return 'before';
    const armed = faults.scyllaFail;
    if (!armed || !String(query).includes(armed.match)) return null;
    if (--armed.times <= 0) faults.scyllaFail = null;
    return armed.after ? 'after' : 'before';
  };
  const timeout = () => new Error('OperationTimedOut (injected)');
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'execute')
        return async (query: string, ...rest: unknown[]) => {
          const fault = decide(query);
          if (fault === 'before') throw timeout();
          const result = await (target.execute as any)(query, ...rest);
          if (fault === 'after') throw timeout();
          const table = TABLE.exec(query)?.[1];
          if (table && /^\s*SELECT/i.test(query))
            counts.set(table, (counts.get(table) ?? 0) + result.rows.length);
          return result;
        };
      if (prop === 'batch')
        return async (
          queries: Array<{ query: string }>,
          ...rest: unknown[]
        ) => {
          const fault = decide(queries.map((q) => q.query).join(';'));
          if (fault === 'before') throw timeout();
          const result = await (target.batch as any)(queries, ...rest);
          if (fault === 'after') throw timeout();
          return result;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A proxy over the Redis client discussions use: every command fails while `redisDown` is set. */
function faultableRedis(client: Redis, faults: Faults): Redis {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (faults.redisDown) throw new Error('redis down (injected)');
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * The real discussions modules (HTTP and worker) behind the production HTTP pipeline, real PostgreSQL, ScyllaDB and
 * Redis. Faked at the edges only: the clock (movable), the event bus (a spy that can refuse), faults in front of the
 * two drivers and the identity directory. Users and products come from the shared fixtures.
 */
export async function createDiscussionsApp(
  options: {
    /** Put a fault proxy in front of the shared Redis (the rate limiter's and idempotency's store). */
    redisProxy?: boolean;
    /** Run the production JSON logger and capture its stdout lines (`logs()`, `rawLogs()`). */
    structuredLogger?: boolean;
  } = {},
): Promise<DiscussionsTestApp> {
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({ host: 'localhost', port: 6400 })
    : null;
  const faults: Faults = {
    scyllaDown: false,
    scyllaFail: null,
    redisDown: false,
    directoryDown: false,
    busDown: false,
  };
  const rowsRead = new Map<string, number>();
  const clockHolder: { clock?: FakeClock } = {};
  const published: PublishedEvent[] = [];
  const bus = {
    publish: (envelope: PublishedEvent) => {
      if (faults.busDown)
        return Promise.reject(new Error('bus down (injected)'));
      published.push(envelope);
      return Promise.resolve();
    },
    publishMany: async (envelopes: PublishedEvent[]) => {
      for (const e of envelopes) await bus.publish(e);
    },
  };

  const base = await createCatalogApp({
    structuredLogger: options.structuredLogger,
    ...(redisProxy && { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` }),
    extraImports: [DiscussionsModule, DiscussionsWorkerModule],
    overrides: [{ provide: EventPublisher, useValue: bus }],
    customize: (builder) =>
      builder
        // the limiter reads the movable clock, so a spec can let a minute pass without sleeping
        .overrideProvider(TimeSource)
        .useValue({ overrideMs: () => clockHolder.clock?.nowMs() ?? null })
        .overrideProvider(SCYLLA_CLIENT)
        .useFactory({
          factory: (cassandra: CassandraService) =>
            faultableCassandra(cassandra.client, faults, rowsRead),
          inject: [CassandraService],
        })
        .overrideProvider(REDIS_CLIENT)
        .useFactory({
          factory: (redis: RedisService) =>
            faultableRedis(redis.client, faults),
          inject: [RedisService],
        }),
  });
  clockHolder.clock = base.clock;
  const app: INestApplication = base.app;
  const sequelize = app.get(Sequelize);
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const cassandra = app.get(CassandraService);
  const redisService = app.get(RedisService);
  const directory = app.get(UserDirectoryService);
  const realLookup = directory.getUsersByIds.bind(directory);
  directory.getUsersByIds = (ids: string[]) =>
    faults.directoryDown
      ? Promise.reject(new Error('directory down (injected)'))
      : realLookup(ids);

  const sql = <T extends object = Record<string, unknown>>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(query, { type: QueryTypes.SELECT, replacements });

  const t: DiscussionsTestApp = {
    ...base,
    redisProxy,
    close: async () => {
      await base.close();
      await redisProxy?.close();
      stdoutSpy?.mockRestore();
    },
    rawLogs: () => logChunks.join(''),
    logs: () =>
      logChunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, any>),
    clearLogs: () => void (logChunks.length = 0),
    faults,
    config,
    published,
    rowsRead,
    resetRowCounts: () => rowsRead.clear(),
    sql,
    cql: (query, params = []) =>
      cassandra.client.execute(query, params as never, {
        prepare: true,
      }) as Promise<types.ResultSet>,
    redis: redisService.client,
    async reset() {
      await base.reset();
      config.reset();
      published.length = 0;
      rowsRead.clear();
      Object.assign(faults, {
        scyllaDown: false,
        scyllaFail: null,
        redisDown: false,
        directoryDown: false,
        busDown: false,
      });
    },
    agedUser(options = {}) {
      const hours = options.ageHours ?? 24 * 30;
      return base.newUser({
        role: options.role,
        createdAt: new Date(base.clock.now().getTime() - hours * 3_600_000),
      });
    },
    async users(n, options = {}) {
      return Promise.all(
        Array.from({ length: n }, () =>
          options.aged ? t.agedUser() : base.newUser(),
        ),
      );
    },
    async product(seed = {}) {
      const shop = await createShop(app, null, {
        name: `Shop ${uuidv4().slice(0, 6)}`,
      });
      return createProduct(app, shop, { status: seed.status ?? 'ACTIVE' });
    },
    async world() {
      const shop = await createShop(app, null, { name: 'Electro' });
      const product = await createProduct(app, shop, { status: 'ACTIVE' });
      const archived = await createProduct(app, shop, { status: 'ARCHIVED' });
      const [author, reader, moderator, seller] = await Promise.all([
        t.agedUser(),
        t.agedUser(),
        t.agedUser({ role: Role.MODERATOR }),
        t.agedUser({ role: Role.SELLER }),
      ]);
      return {
        shopId: shop.id,
        product,
        archived,
        author,
        reader,
        moderator,
        seller,
      };
    },
    relay: () => app.get(EventRelayService).relay(48),
    async runJob(type, payload = {}) {
      // the handler bodies of the worker's job class, as the jobs worker would call them with a validated payload
      const jobs = app.get(DiscussionsJobs);
      const handlers: Record<string, () => Promise<void>> = {
        'discussions.flush-votes': () => jobs.flush(),
        'discussions.relay-events': () => jobs.relayEvents(),
        'discussions.relay-sweep': () => jobs.relaySweep(),
        'discussions.reconcile': () => jobs.reconciliation(),
        'discussions.recount': () =>
          jobs.recount(payload as { targetId: string }),
        'discussions.backfill': () =>
          jobs.backfillStep(
            payload as {
              phase: 'boards' | 'threads';
              pageState: string | null;
            },
          ),
      };
      const handler = handlers[type];
      if (!handler) throw new Error(`no job handler for ${type}`);
      getJobTypeDeclaration(type)!.contract.parse(payload);
      await handler();
    },
    reconcile: () => app.get(ReconcileService).reconcile(),
    async cacheKeys() {
      const keys = await redisService.client.keys('dsc:*');
      return Promise.all(
        keys.map(async (key) => ({
          key,
          ttl: await redisService.client.ttl(key),
        })),
      );
    },
    async flushDiscussionCache() {
      const keys = await redisService.client.keys('dsc:*');
      if (keys.length) await redisService.client.del(...keys);
    },
    post: (user, productId, body = {}, key = uuidv4()) =>
      base
        .as(user)
        .post(`/api/boards/${productId}/posts`)
        .set('Idempotency-Key', key)
        .send({
          title: 'Does it work with USB-C?',
          body: 'Yes, mostly.',
          ...body,
        }),
    comment: (user, postId, body, key = uuidv4()) =>
      base
        .as(user)
        .post(`/api/posts/${postId}/comments`)
        .set('Idempotency-Key', key)
        .send({ body: 'A comment', ...body }),
    vote: (user, targetId, value) =>
      base.as(user).put(`/api/votes/${targetId}`).send({ value }),
    async newPost(user, productId, over = {}) {
      const res = await t.post(user, productId, over);
      if (res.status !== 201)
        throw new Error(
          `create post: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body.postId as string;
    },
    async newComment(user, postId, over = {}) {
      const res = await t.comment(user, postId, over);
      if (res.status !== 201)
        throw new Error(
          `create comment: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body.commentId as string;
    },
  };
  return t;
}
