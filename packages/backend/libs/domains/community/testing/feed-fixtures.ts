import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Client, types } from 'cassandra-driver';
import type Redis from 'ioredis';
import supertest from 'supertest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  feedPageSchema,
  type FeedPage,
  auctionEventSchemas,
  discussionPostCreatedPayloadSchema,
  discussionPostDeletedPayloadSchema,
  eventEnvelopeSchema,
  feedItemPublishedPayloadSchema,
  productDeletedPayloadSchema,
  productSnapshotSchema,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import type { Projector } from '@app/infrastructure/projections/projector';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  AuthApiModule,
  KeyStore,
  UserDirectoryService,
} from '@app/domains/identity';
import { ShopQueryService } from '@app/domains/tenancy';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { AnnouncementRelayService } from '../application/announcement-relay.service';
import { DiscussionQueryService } from '../application/discussion-query.service';
import { FanoutService } from '../application/fanout.service';
import {
  FEED_REDIS_CLIENT,
  FEED_SCYLLA_CLIENT,
  POST_STORE,
  type PostStore,
} from '../domain/ports';
import { TimeIdGenerator, sortableId } from '../domain/ids';
import { FeedProjectorsModule } from '../feed-projectors.module';
import { FeedStoresModule } from '../feed-stores.module';
import { FeedWorkerModule } from '../feed-worker.module';
import { FeedModule } from '../feed.module';
import {
  FeedFanoutProjector,
  FeedPostsProjector,
  FeedProductsProjector,
} from '../infra/feed-projectors';

/**
 * Shared kit of the six S26 e2e files (T019). Real HTTP pipeline, real PostgreSQL (sessions and shops only), ScyllaDB
 * and Redis. Seeding goes through the shared user and tenancy fixtures and `SessionIssuer` (via `issueSession`):
 * no spec injects `UserModel`, `ShopModel` or `ProductModel`. Source events are contract-valid envelopes built from the
 * contract schemas, so a fixture cannot drift from `packages/contracts`. Faked only at the edges: the clock (frozen),
 * the bus (a spy that can pause and refuse), and switchable failures at the exported-service edge (S03 shops, S25
 * posts, S01 users) and at the timeline (Redis) and durable (ScyllaDB) drivers. Each test creates its own data.
 *
 * Extension points for later phases (kept here so the six files share one kit):
 *  - `FEED_APP_MODULES`: T055 adds `FeedWorkerModule` and `FeedProjectorsModule` (and drops the stores module once
 *    `FeedModule` imports it);
 *  - `deliver()` takes any `Projector`; the four projector classes of T033 are fetched with `t.projector(Class)`.
 */

export interface TestUser {
  id: string;
  email: string;
  /** `Bearer <access token>` */
  bearer: string;
  sessionId: string;
}

type Agent = ReturnType<typeof supertest>;

/** Switchable failures (all off after `reset()`). */
export interface FeedFaults {
  /** Every ScyllaDB call of the feed fails (as a timeout would). */
  durableDown: boolean;
  /**
   * The next `times` ScyllaDB calls whose CQL contains `match` fail; with `after` the call lands first and the answer is
   * lost.
   */
  durableFail: { match: string; times: number; after?: boolean } | null;
  /** Every Redis call of the feed (timeline, markers, recents) fails. */
  timelineDown: boolean;
  /** S03 `getShopsByIds` throws. */
  shopsDown: boolean;
  /** S25 `getPostsByIds` throws. */
  postsDown: boolean;
  /** S01 `getUsersByIds` throws. */
  usersDown: boolean;
  /** The bus refuses publishes. */
  busDown: boolean;
}

export interface PublishedEvent {
  eventId: string;
  type: string;
  aggregateId: string;
  payload: Record<string, any>;
}

/** The bus spy: records accepted publishes in order (duplicates kept); can be paused (publishes wait) and refuse. */
export class BusSpy {
  readonly published: PublishedEvent[] = [];
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  down = false;

  pause(): void {
    if (this.gate) return;
    this.gate = new Promise<void>((resolve) => (this.open = resolve));
  }

  resume(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  async publish(envelope: PublishedEvent): Promise<void> {
    if (this.gate) await this.gate;
    if (this.down) throw new Error('bus down (injected)');
    this.published.push(envelope);
  }

  async publishMany(envelopes: PublishedEvent[]): Promise<void> {
    for (const e of envelopes) await this.publish(e);
  }

  ofType(type: string): PublishedEvent[] {
    return this.published.filter((e) => e.type === type);
  }

  reset(): void {
    this.resume();
    this.published.length = 0;
    this.down = false;
  }
}

export interface ProductEventInput {
  productId?: string;
  shopId: string;
  title?: string;
  priceMinor?: number;
  currency?: string;
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  isSandbox?: boolean;
  productVersion?: number;
  changedFields?: string[];
  occurredAt?: Date;
  eventId?: string;
}

export interface FeedTestApp {
  app: INestApplication;
  /** Frozen at creation; `advance` moves it. The injected clock of the feed and the limiter's time source. */
  clock: FakeClock;
  config: MockApiConfigService;
  http(): Agent;
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    put(url: string): ReturnType<Agent['put']>;
    delete(url: string): ReturnType<Agent['delete']>;
  };
  faults: FeedFaults;
  bus: BusSpy;
  /** A shop's status as the S03 batch query reports it (the exported-service edge); `null` removes the override. */
  setShopStatus(
    shopId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED' | null,
  ): void;
  /** A product item created through the real consumer at `at`; returns the product and its item id. */
  newProductItem(
    shop: { shopId: string },
    at: Date,
    options?: { title?: string; priceMinor?: number; productId?: string },
  ): Promise<{ productId: string; itemId: string }>;
  /** A real S25 post (written through the posts store of `community`) and its `post` item through the real consumer. */
  newPostItem(input: {
    authorId: string;
    at: Date;
    title?: string;
  }): Promise<{ postId: string; boardId: string; itemId: string }>;
  /** Deletes the S25 post the way S25 does (tombstone); the feed consumer is not told. */
  deletePost(postId: string): Promise<void>;
  /** Relays every pending announcement and fans them out in creation order; returns them by item id. */
  publishAll(): Promise<Map<string, PublishedEvent>>;
  /** `follow` then one feed read, so the reader is active with a complete timeline. */
  activate(user: TestUser, accountId: string): Promise<void>;
  /** `GET /feed` expecting 200, parsed with the contract schema. */
  readPage(
    user: TestUser,
    query?: Record<string, string | number>,
  ): Promise<FeedPage>;
  /** The sortable ids of a user's pushed timeline, newest first. */
  timeline(user: TestUser): Promise<string[]>;
  fanoutService(): FanoutService;
  /** Raw ScyllaDB access for assertions (the fixture edge; not the faultable client). */
  cql(query: string, params?: unknown[]): Promise<types.ResultSet>;
  /** The shared Redis client for assertions (never faulted). */
  redis: Redis;
  /** `fd:*` keys with their remaining TTL in seconds (-1 = none). Test-only enumeration. */
  feedKeys(): Promise<Array<{ key: string; ttl: number }>>;
  newUser(options?: { email?: string }): Promise<TestUser>;
  users(n: number): Promise<TestUser[]>;
  /** A shop through the shared tenancy fixtures; `status` other than ACTIVE seeds a closed shop. */
  seedShop(options?: {
    name?: string;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
    owner?: TestUser;
  }): Promise<{ shopId: string; accountId: string; name: string }>;
  /** `POST /follow/:accountId`. */
  follow(user: TestUser, accountId: string): ReturnType<Agent['post']>;
  unfollow(user: TestUser, accountId: string): ReturnType<Agent['delete']>;
  feed(
    user: TestUser,
    query?: Record<string, string | number>,
  ): ReturnType<Agent['get']>;
  following(
    user: TestUser,
    query?: Record<string, string | number>,
  ): ReturnType<Agent['get']>;
  followStatus(user: TestUser, accountIds: string[]): ReturnType<Agent['get']>;
  /** Hands a batch to a projector exactly as the S53 runner would: validate against `handles`, then `project`. */
  deliver(
    projector: Projector,
    events: EventEnvelope[],
  ): Promise<{ deadLettered: Array<{ event: EventEnvelope; reason: string }> }>;
  /** Runs one pass of the announcement relay; returns the announcements it published, in order. */
  announce(): Promise<PublishedEvent[]>;
  /** Delivers announcements to the fan-out consumer in the given order (as `feed.item_published` envelopes). */
  fanOut(
    announcements: PublishedEvent[],
  ): Promise<{ deadLettered: Array<{ event: EventEnvelope; reason: string }> }>;
  /** The provider instance of a projector class registered by the app under test. */
  projector<T extends Projector>(type: abstract new (...args: never[]) => T): T;
  // contract-valid source events (S05, S25, S21) and the S26 announcement
  productEvent(
    kind: 'created' | 'updated' | 'archived' | 'restored',
    input: ProductEventInput,
  ): EventEnvelope;
  productDeleted(input: {
    productId: string;
    shopId: string;
    productVersion: number;
    eventId?: string;
  }): EventEnvelope;
  postCreated(input: {
    postId?: string;
    boardId?: string;
    authorId: string;
    title?: string;
    eventId?: string;
    createdAt?: Date;
  }): EventEnvelope;
  postDeleted(input: {
    postId: string;
    boardId?: string;
    deletedBy?: 'author' | 'moderator';
    eventId?: string;
  }): EventEnvelope;
  auctionCreated(input: {
    auctionId?: string;
    shopId: string;
    productId: string;
    startsAt?: Date;
    endsAt?: Date;
    auctionVersion?: number;
    eventId?: string;
  }): EventEnvelope;
  auctionOpened(input: {
    auctionId: string;
    shopId: string;
    productId: string;
    endsAt?: Date;
    auctionVersion?: number;
    eventId?: string;
  }): EventEnvelope;
  itemPublished(input: {
    itemId: string;
    authorId: string;
    kind?:
      | 'new_product'
      | 'price_drop'
      | 'post'
      | 'drop_announced'
      | 'auction_started';
    createdAt?: Date;
    eventId?: string;
  }): EventEnvelope;
  /** Empties the stores, resets the clock, the faults and the bus spy. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The modules the feed specs boot next to the identity API. T055 appends the worker and projector modules here.
 * `FeedStoresModule` is listed so the driver-edge overrides below always find their providers.
 */
export const FEED_APP_MODULES: unknown[] = [
  FeedStoresModule,
  FeedModule,
  FeedWorkerModule,
  FeedProjectorsModule,
];

/** A proxy over the ScyllaDB driver client: fails on demand (before or after the call lands). */
function faultableCassandra(client: Client, faults: FeedFaults): Client {
  const decide = (query: unknown): 'before' | 'after' | null => {
    if (faults.durableDown) return 'before';
    const armed = faults.durableFail;
    if (!armed || !String(query).includes(armed.match)) return null;
    if (--armed.times <= 0) faults.durableFail = null;
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

/** A proxy over the Redis client of the feed: every command fails while `timelineDown` is set. */
function faultableRedis(client: Redis, faults: FeedFaults): Redis {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (faults.timelineDown) throw new Error('redis down (injected)');
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Wraps one async method of a real collaborator so it rejects while `isDown()` holds. */
function failWhile<T extends object>(
  target: T,
  method: keyof T,
  isDown: () => boolean,
  message: string,
): void {
  const original = target[method] as unknown as (...a: unknown[]) => unknown;
  (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) =>
    isDown()
      ? Promise.reject(new Error(message))
      : original.apply(target, args);
}

export async function createFeedApp(
  options: {
    extraImports?: unknown[];
    env?: Record<string, string>;
  } = {},
): Promise<FeedTestApp> {
  const env = options.env ?? {};
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);

  const faults: FeedFaults = {
    durableDown: false,
    durableFail: null,
    timelineDown: false,
    shopsDown: false,
    postsDown: false,
    usersDown: false,
    busDown: false,
  };
  const bus = new BusSpy();
  const clock = new FakeClock(new Date());

  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        SeedsModule,
        ...FEED_APP_MODULES,
        ...(options.extraImports ?? []),
      ],
      {
        stores: ['redis', 'cassandra', 'dynamo'],
        customize: (builder) =>
          builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(EventPublisher)
            .useValue(bus)
            // the limiter reads the movable clock, so a spec can let a minute pass without sleeping
            .overrideProvider(TimeSource)
            .useValue({ overrideMs: () => clock.nowMs() })
            .overrideProvider(FEED_SCYLLA_CLIENT)
            .useFactory({
              factory: (cassandra: CassandraService) =>
                faultableCassandra(cassandra.client, faults),
              inject: [CassandraService],
            })
            .overrideProvider(FEED_REDIS_CLIENT)
            .useFactory({
              factory: (redis: RedisService) =>
                faultableRedis(redis.client, faults),
              inject: [RedisService],
            }),
      },
    );
    app = moduleRef.createNestApplication({ bufferLogs: false });
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
  const cassandra = app.get(CassandraService);
  const redisService = app.get(RedisService);
  const config = app.get(ApiConfigService) as unknown as MockApiConfigService;
  const http = () => supertest(app.getHttpServer());
  let counter = 0;

  // failures at the exported-service edge: the production instances stay underneath
  const shopStatuses = new Map<
    string,
    'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED'
  >();
  const shopQuery = app.get(ShopQueryService, { strict: false });
  const realShops = shopQuery.getShopsByIds.bind(shopQuery);
  shopQuery.getShopsByIds = async (ids: string[]) => {
    if (faults.shopsDown) throw new Error('shop directory down (injected)');
    const found = await realShops(ids);
    for (const [id, shop] of found) {
      const status = shopStatuses.get(id);
      if (status) found.set(id, { ...shop, status } as typeof shop);
    }
    return found;
  };
  // the post lookup exists once the feed module imports S25's stores (hydration, T049)
  const posts = (() => {
    try {
      return app.get(DiscussionQueryService, { strict: false });
    } catch {
      return null;
    }
  })();
  if (posts)
    failWhile(
      posts,
      'getPostsByIds',
      () => faults.postsDown,
      'post lookup down (injected)',
    );
  failWhile(
    app.get(UserDirectoryService, { strict: false }),
    'getUsersByIds',
    () => faults.usersDown,
    'user directory down (injected)',
  );

  const as: FeedTestApp['as'] = (user) => ({
    get: (url) => http().get(url).set('Authorization', user.bearer),
    post: (url) => http().post(url).set('Authorization', user.bearer),
    put: (url) => http().put(url).set('Authorization', user.bearer),
    delete: (url) => http().delete(url).set('Authorization', user.bearer),
  });

  const envelope = (
    type: string,
    aggregateType: string,
    aggregateId: string,
    aggregateVersion: number,
    schema: z.ZodType,
    payload: unknown,
    meta: { eventId?: string; occurredAt?: Date } = {},
  ): EventEnvelope =>
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

  const productSnapshot = (input: ProductEventInput) => {
    const now = (input.occurredAt ?? clock.now()).toISOString();
    return {
      productId: input.productId ?? uuidv4(),
      shopId: input.shopId,
      title: input.title ?? 'Lamp',
      description: 'A fixture product',
      brand: 'Acme',
      category: 'home',
      priceMinor: input.priceMinor ?? 12_900,
      currency: input.currency ?? 'USD',
      rating: 0,
      tags: [],
      quantity: 5,
      inStock: true,
      status: input.status ?? 'ACTIVE',
      isSandbox: input.isSandbox ?? false,
      externalSku: null,
      productVersion: input.productVersion ?? 1,
      createdAt: now,
      updatedAt: now,
      changedFields: input.changedFields ?? [],
    };
  };

  const postIds = new TimeIdGenerator({
    bytes: (length) => new Uint8Array(randomBytes(length)),
  });
  const claimedItem = async (kind: string, key: string): Promise<string> =>
    (
      await cassandra.client.execute(
        'SELECT item_id FROM item_claims WHERE kind = ? AND source_key = ?',
        [kind, key],
        { prepare: true },
      )
    )
      .first()
      ?.item_id.toString() as string;

  const t: FeedTestApp = {
    app,
    clock,
    config,
    http,
    as,
    faults,
    bus,
    cql: (query, params = []) =>
      cassandra.client.execute(query, params as never, {
        prepare: true,
      }) as Promise<types.ResultSet>,
    redis: redisService.client,
    setShopStatus(shopId, status) {
      if (status) shopStatuses.set(shopId, status);
      else shopStatuses.delete(shopId);
    },
    async newProductItem(shop, at, options = {}) {
      const productId = options.productId ?? uuidv4();
      await t.projector(FeedProductsProjector).project([
        t.productEvent('created', {
          productId,
          shopId: shop.shopId,
          occurredAt: at,
          title: options.title,
          priceMinor: options.priceMinor,
        }),
      ]);
      return { productId, itemId: await claimedItem('new_product', productId) };
    },
    async newPostItem(input) {
      // S25 post ids are time-based (the column is a timeuuid)
      const postId = postIds.next(input.at);
      const boardId = uuidv4();
      await app.get<PostStore>(POST_STORE, { strict: false }).insert(
        {
          postId,
          boardId,
          authorId: input.authorId,
          title: input.title ?? 'A post',
          bodyMd: 'body',
          bodyHtml: '<p>body</p>',
          htmlVersion: 1,
          createdAt: input.at,
          deleted: false,
          deletedBy: null,
          shadow: false,
        },
        null,
      );
      await t.projector(FeedPostsProjector).project([
        t.postCreated({
          postId,
          boardId,
          authorId: input.authorId,
          title: input.title,
          createdAt: input.at,
        }),
      ]);
      return { postId, boardId, itemId: await claimedItem('post', postId) };
    },
    async deletePost(postId) {
      const store = app.get<PostStore>(POST_STORE, { strict: false });
      const row = await store.get(postId);
      if (row) await store.tombstone(row, 'author', null);
    },
    async publishAll() {
      const announced = (await t.announce()).sort((a, b) =>
        sortableId(a.payload.itemId) < sortableId(b.payload.itemId) ? -1 : 1,
      );
      await t.fanOut(announced);
      return new Map(announced.map((a) => [a.payload.itemId as string, a]));
    },
    async activate(user, accountId) {
      await t.follow(user, accountId).expect(204);
      await t.feed(user).expect(200);
    },
    async readPage(user, query = {}) {
      return feedPageSchema.parse((await t.feed(user, query).expect(200)).body);
    },
    timeline: (user) =>
      redisService.client.zrevrange(`fd:tl:{${user.id}}`, 0, -1),
    fanoutService: () => app.get(FanoutService, { strict: false }),
    async feedKeys() {
      const keys = await redisService.client.keys('fd:*');
      return Promise.all(
        keys.map(async (key) => ({
          key,
          ttl: await redisService.client.ttl(key),
        })),
      );
    },
    async newUser(opts = {}) {
      const user = await createUser(app, {
        email: opts.email ?? `feed-${++counter}-${Date.now()}@example.com`,
      });
      const session = await issueSession(app, { id: user.id, role: user.role });
      return {
        id: user.id,
        email: user.email,
        bearer: session.bearer,
        sessionId: session.sessionId,
      };
    },
    users: (n) => Promise.all(Array.from({ length: n }, () => t.newUser())),
    async seedShop(opts = {}) {
      const name = opts.name ?? `Shop ${uuidv4().slice(0, 6)}`;
      const shop = await createShop(
        app,
        opts.owner ? { id: opts.owner.id } : null,
        { name, status: opts.status },
      );
      return { shopId: shop.id, accountId: `shop:${shop.id}`, name };
    },
    follow: (user, accountId) => as(user).post(`/api/follow/${accountId}`),
    unfollow: (user, accountId) => as(user).delete(`/api/follow/${accountId}`),
    feed: (user, query = {}) => as(user).get('/api/feed').query(query),
    following: (user, query = {}) =>
      as(user).get('/api/me/following').query(query),
    followStatus: (user, accountIds) =>
      as(user)
        .get('/api/follow-status')
        .query({ accountIds: accountIds.join(',') }),
    async deliver(projector, events) {
      const deadLettered: Array<{ event: EventEnvelope; reason: string }> = [];
      const valid: EventEnvelope[] = [];
      for (const event of events) {
        const handled = projector.handles.find(
          (h) =>
            h.event.type === event.type && h.event.version === event.version,
        );
        if (!handled) continue; // unknown types are skipped by the runner
        const parsed = handled.event.schema.safeParse(event.payload);
        if (!parsed.success)
          deadLettered.push({ event, reason: 'invalid_payload' });
        else valid.push({ ...event, payload: parsed.data });
      }
      if (valid.length) await projector.project(valid);
      return { deadLettered };
    },
    projector: (type) => app.get(type as never, { strict: false }),
    async announce() {
      const before = bus.published.length;
      await app.get(AnnouncementRelayService, { strict: false }).relay();
      return bus.published.slice(before);
    },
    fanOut(announcements) {
      return t.deliver(
        app.get(FeedFanoutProjector, { strict: false }),
        announcements.map((a) =>
          t.itemPublished({
            itemId: a.payload.itemId,
            authorId: a.payload.authorId,
            kind: a.payload.kind,
            createdAt: new Date(a.payload.createdAt),
            eventId: a.eventId,
          }),
        ),
      );
    },
    productEvent(kind, input) {
      const snapshot = productSnapshot(input);
      return envelope(
        `catalog.product_${kind}`,
        'products',
        snapshot.productId,
        snapshot.productVersion,
        productSnapshotSchema,
        snapshot,
        input,
      );
    },
    productDeleted: (input) =>
      envelope(
        'catalog.product_deleted',
        'products',
        input.productId,
        input.productVersion,
        productDeletedPayloadSchema,
        {
          productId: input.productId,
          shopId: input.shopId,
          productVersion: input.productVersion,
        },
        input,
      ),
    postCreated(input) {
      const postId = input.postId ?? uuidv7();
      return envelope(
        'discussion.post_created',
        'discussion',
        postId,
        1,
        discussionPostCreatedPayloadSchema,
        {
          postId,
          boardId: input.boardId ?? uuidv4(),
          authorId: input.authorId,
          title: input.title ?? 'A post',
          createdAt: (input.createdAt ?? clock.now()).toISOString(),
        },
        { eventId: input.eventId, occurredAt: input.createdAt },
      );
    },
    postDeleted: (input) =>
      envelope(
        'discussion.post_deleted',
        'discussion',
        input.postId,
        2,
        discussionPostDeletedPayloadSchema,
        {
          postId: input.postId,
          boardId: input.boardId ?? uuidv4(),
          deletedBy: input.deletedBy ?? 'author',
        },
        input,
      ),
    auctionCreated(input) {
      const auctionId = input.auctionId ?? uuidv4();
      const startsAt = input.startsAt ?? new Date(clock.nowMs() + 3_600_000);
      return envelope(
        'auction.created',
        'auctions',
        auctionId,
        input.auctionVersion ?? 1,
        auctionEventSchemas['auction.created'],
        {
          auctionId,
          shopId: input.shopId,
          productId: input.productId,
          auctionVersion: input.auctionVersion ?? 1,
          startsAt: startsAt.toISOString(),
          endsAt: (
            input.endsAt ?? new Date(startsAt.getTime() + 86_400_000)
          ).toISOString(),
          currency: 'USD',
        },
        input,
      );
    },
    auctionOpened: (input) =>
      envelope(
        'auction.opened',
        'auctions',
        input.auctionId,
        input.auctionVersion ?? 2,
        auctionEventSchemas['auction.opened'],
        {
          auctionId: input.auctionId,
          shopId: input.shopId,
          productId: input.productId,
          auctionVersion: input.auctionVersion ?? 2,
          endsAt: (
            input.endsAt ?? new Date(clock.nowMs() + 86_400_000)
          ).toISOString(),
        },
        input,
      ),
    itemPublished: (input) =>
      envelope(
        'feed.item_published',
        'feed',
        input.authorId,
        1,
        feedItemPublishedPayloadSchema,
        {
          itemId: input.itemId,
          authorId: input.authorId,
          kind: input.kind ?? 'new_product',
          createdAt: (input.createdAt ?? clock.now()).toISOString(),
        },
        { eventId: input.eventId, occurredAt: input.createdAt },
      ),
    async reset() {
      await seeds.clean();
      // the relay scans every recent hour: announcements another test left behind must not leak into this one
      await cassandra.client.execute(
        'TRUNCATE marketplace.pending_announcements',
      );
      await cassandra.client.execute('TRUNCATE marketplace.dead_announcements');
      const keys = await redisService.client.keys('fd:*');
      if (keys.length) await redisService.client.del(...keys);
      app.get(KeyStore).invalidate();
      config.reset();
      bus.reset();
      shopStatuses.clear();
      Object.assign(faults, {
        durableDown: false,
        durableFail: null,
        timelineDown: false,
        shopsDown: false,
        postsDown: false,
        usersDown: false,
        busDown: false,
      });
    },
    close: () => app.close(),
  };

  // `faults.busDown` is the documented switch; the spy reads it through this accessor
  Object.defineProperty(bus, 'down', {
    get: () => faults.busDown,
    set: (value: boolean) => void (faults.busDown = value),
  });
  return t;
}

/** The sortable form of an item id (Redis members, ordering assertions). */
export const sortable = (itemId: string): string => sortableId(itemId);
