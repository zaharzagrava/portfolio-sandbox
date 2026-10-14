import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { generateTestingModule } from '@app/test/utils/global-modules';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { issueSession } from '@app/test/seeds/session.fixture';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { DevelopersModule } from '../developers.module';
import { RequestRecord, RequestRecordPublisher } from '../domain/ports';
import { RequestRecordSink } from '../infra/request-record.sink';
import { publicApiRequestContext, PublicApiModule } from '../public-api.module';

export type { TestUser };

/** The event bus at its edge: keeps what the sink publishes, or refuses while `down` (AS-61). */
export class RecordingPublisher extends RequestRecordPublisher {
  readonly records: RequestRecord[] = [];
  down = false;

  publish(records: RequestRecord[]): Promise<void> {
    if (this.down) return Promise.reject(new Error('event bus is down'));
    this.records.push(...records);
    return Promise.resolve();
  }

  /** The records of one request id (a call must leave exactly one). */
  of(requestId: string): RequestRecord[] {
    return this.records.filter((r) => r.requestId === requestId);
  }

  reset(): void {
    this.records.length = 0;
    this.down = false;
  }
}

/** The frozen instant every spec of this capability starts from (test-plan.md): time moves only through `advance`. */
export const FROZEN_NOW = new Date('2026-10-06T12:00:00.000Z');

type Agent = ReturnType<typeof supertest>;

/** One running copy of the `apps/public-api` deployable (its own Nest app, port, caches), on the shared stores. */
export interface PublicApiInstance {
  app: INestApplication;
  http(): Agent;
  /** `Authorization: Bearer <key>` request helpers. */
  withKey(key: string): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    patch(url: string): ReturnType<Agent['patch']>;
    delete(url: string): ReturnType<Agent['delete']>;
    head(url: string): ReturnType<Agent['head']>;
  };
  close(): Promise<void>;
}

export interface PublicApiKit extends CatalogTestApp {
  /** The dashboard app (`apps/core` shape, prefix `/api`) is `app`; this is the shared clock. */
  clock: FakeClock;
  queue: InMemoryTaskQueue;
  /** What the public instances published as request records. */
  records: RecordingPublisher;
  /** Publishes every instance's buffered request records (the sink is asynchronous by design). */
  flushRecords(): Promise<void>;
  /**
   * Boots another public-API instance (instance 1 and 2 of AS-08); closed by `close()`. `env` is read once at boot
   * (a pepper pair, the address of a fault proxy for the database).
   */
  publicInstance(options?: {
    env?: Record<string, string>;
  }): Promise<PublicApiInstance>;
  /** The first public instance, booted by `createPublicApiKit`. */
  pub: PublicApiInstance;
  /** A manager of a fresh shop (L-005, L-006: every spec creates its own world). */
  seedWorld(): Promise<ShopWorld>;
  /** A session of the same user whose token carries a second factor (`amr` ∋ `mfa`). */
  withMfa(user: TestUser): Promise<TestUser>;
}

export interface ShopWorld {
  owner: TestUser;
  /** The owner's session after a second factor. */
  ownerMfa: TestUser;
  shop: { id: string };
}

export interface CreatedKey {
  id: string;
  key: string;
  prefix: string;
  status: string;
  [field: string]: unknown;
}

/**
 * The real apps the S42 specs run against: the dashboard routes (`DevelopersModule`, prefix `/api`, real sessions and
 * tenancy) and one or more `PublicApiModule` instances (no prefix, as `apps/public-api`), over real Postgres, Redis,
 * ClickHouse and the queue port, with the production pipe, filter and limiter. Faked only at system edges: the clock
 * (shared by every instance), the queue (in memory, same option validation) and the faults of `faults.ts`.
 */
export async function createPublicApiKit(
  options: {
    dashboardImports?: unknown[];
    publicImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
  } = {},
): Promise<PublicApiKit> {
  const queue = new InMemoryTaskQueue();
  const records = new RecordingPublisher();
  const overrides = [
    { provide: RequestRecordPublisher, useValue: records },
    ...(options.overrides ?? []),
  ];
  const base = await createCatalogApp({
    extraImports: [DevelopersModule, ...(options.dashboardImports ?? [])],
    overrides: [{ provide: TaskQueue, useValue: queue }, ...overrides],
    env: options.env,
  });
  base.clock.set(FROZEN_NOW);

  const instances: PublicApiInstance[] = [];
  const publicInstance = async (
    instanceOptions: { env?: Record<string, string> } = {},
  ): Promise<PublicApiInstance> => {
    const env = { ...options.env, ...instanceOptions.env };
    const previous = Object.fromEntries(
      Object.keys(env).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, env);
    let app: INestApplication;
    try {
      const moduleRef = await generateTestingModule(
        [PublicApiModule, ...(options.publicImports ?? [])],
        {
          stores: ['redis', 'sqs'],
          customize: (builder) => {
            let b = builder
              .overrideProvider(CLOCK)
              .useValue(base.clock)
              .overrideProvider(TaskQueue)
              .useValue(queue);
            for (const o of overrides)
              b = b.overrideProvider(o.provide).useValue(o.useValue);
            return b;
          },
        },
      );
      app = moduleRef.createNestApplication({ bufferLogs: false });
      configureHttpApp(app, {
        globalPrefix: false,
        cors: false,
        useStructuredLogger: false,
        processHandlers: false,
        beforeBodyParsing: [publicApiRequestContext(app)],
      });
      await app.listen(0, '127.0.0.1');
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const http = () => supertest(app.getHttpServer());
    const instance: PublicApiInstance = {
      app,
      http,
      withKey: (key) => ({
        get: (url) => http().get(url).set('Authorization', `Bearer ${key}`),
        post: (url) => http().post(url).set('Authorization', `Bearer ${key}`),
        patch: (url) => http().patch(url).set('Authorization', `Bearer ${key}`),
        delete: (url) =>
          http().delete(url).set('Authorization', `Bearer ${key}`),
        head: (url) => http().head(url).set('Authorization', `Bearer ${key}`),
      }),
      close: () => app.close(),
    };
    instances.push(instance);
    return instance;
  };
  const pub = await publicInstance();

  const withMfa = async (user: TestUser): Promise<TestUser> => {
    const session = await issueSession(
      base.app,
      { id: user.id, role: 'USER' },
      { amr: ['pwd', 'totp', 'mfa'] },
    );
    return {
      ...user,
      bearer: session.bearer,
      sessionId: session.sessionId,
    };
  };

  return {
    ...base,
    queue,
    records,
    async flushRecords() {
      await Promise.all(
        instances.map((i) => i.app.get(RequestRecordSink).flush()),
      );
    },
    pub,
    publicInstance,
    withMfa,
    async seedWorld() {
      const owner = await base.newUser();
      const shop = await createShop(base.app, owner);
      return { owner, ownerMfa: await withMfa(owner), shop };
    },
    async reset() {
      await base.reset();
      base.clock.set(FROZEN_NOW);
      records.reset();
      await clearRateLimits(base.app);
    },
    async close() {
      await Promise.all(instances.map((i) => i.close()));
      await base.close();
    },
  };
}

// ---------------------------------------------------------------- fixtures

/** A shop member of the given role. */
export async function addShopMember(
  t: PublicApiKit,
  shopId: string,
  role: 'ADMIN' | 'STAFF' | 'VIEWER',
): Promise<TestUser> {
  const user = await t.newUser();
  await addMember(t.app, shopId, user.id, role);
  return user;
}

/** `POST /api/shops/:shopId/developers/keys` as the shop's manager (with a second factor unless a user is given). */
export async function createKey(
  t: PublicApiKit,
  world: ShopWorld,
  body: Partial<{
    name: string;
    scopes: string[];
    livemode: boolean;
    expiresAt: string;
  }> = {},
  as: TestUser = world.ownerMfa,
): Promise<CreatedKey> {
  const res = await t
    .as(as)
    .post(`/api/shops/${world.shop.id}/developers/keys`)
    .send({
      name: 'ERP',
      scopes: ['products:read', 'products:write', 'orders:read', 'stock:write'],
      livemode: true,
      ...body,
    });
  if (res.status !== 201)
    throw new Error(`createKey: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as CreatedKey;
}

// ---------------------------------------------------------------- data access for assertions

/** Rows of a table for assertions (test code may read every table, IX.6). */
export function rows<T extends object>(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return app
    .get(Sequelize)
    .query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** A statement that changes test data. */
export async function exec(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await app.get(Sequelize).query(sql, { replacements });
}

export { seedOrder, type SeededOrder } from '@app/test/utils/order-fixtures';

/** The events committed to the outbox (event payload, not the envelope), oldest first; filter by aggregate and/or shop. */
export function outboxEvents(
  app: INestApplication,
  eventName: string,
  filter: { aggregateId?: string; shopId?: string } = {},
): Promise<
  {
    eventName: string;
    aggregateId: string;
    aggregateVersion: number;
    payload: any;
    xmin: string;
  }[]
> {
  return rows(
    app,
    `SELECT "eventName", "aggregateId", (payload->>'aggregateVersion')::int AS "aggregateVersion",
            payload->'payload' AS payload, xmin::text AS xmin
       FROM "Outbox"
      WHERE "eventName" = :eventName
        AND (CAST(:aggregateId AS text) IS NULL OR "aggregateId" = :aggregateId)
        AND (CAST(:shopId AS text) IS NULL OR payload->'payload'->>'shopId' = :shopId)
      ORDER BY "createdAt", id`,
    {
      eventName,
      aggregateId: filter.aggregateId ?? null,
      shopId: filter.shopId ?? null,
    },
  );
}

/** Polls `condition` until it holds (no fixed sleeps, L-007); fails with `label` after `timeoutMs`. */
export async function waitFor<T>(
  condition: () => Promise<T | false | undefined | null>,
  label: string,
  timeoutMs = Number(process.env.PW_EXPECT_TIMEOUT_MS ?? 10_000),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const newId = (): string => uuidv7();

/** Forgets every rate-limit counter (a spec that repeats calls from one address many times). */
export async function clearRateLimits(app: INestApplication): Promise<void> {
  const redis = app.get(RedisService).client;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      'rl:*',
      'COUNT',
      1000,
    );
    cursor = next;
    if (keys.length) await redis.unlink(...keys);
  } while (cursor !== '0');
}

/** The shared Redis (fast store) refuses every key starting with `prefix` (an ACL rule) until `allow()`; restore in `afterEach`. */
export function fastStoreOf(app: INestApplication) {
  const redis = app.get(RedisService).client;
  const patternsExcluding = (prefix: string): string[] =>
    [...prefix].map((_, i) => `${prefix.slice(0, i)}[^${prefix[i]}]*`);
  return {
    async deny(prefix: string) {
      await redis.call(
        'ACL',
        'SETUSER',
        'default',
        'resetkeys',
        ...patternsExcluding(prefix).map((p) => `~${p}`),
      );
    },
    async allow() {
      await redis.call('ACL', 'SETUSER', 'default', 'allkeys');
    },
  };
}
