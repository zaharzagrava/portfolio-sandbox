import { QueryTypes } from 'sequelize';
import type { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
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
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { AddressInfo } from 'node:net';
import { IdentityTopicsModule } from '@app/domains/identity';
import {
  RealtimePublisher,
  RealtimeStreamModule,
  realtimeRatePolicies,
} from '@app/infrastructure/realtime';
import { ChatTopicsModule } from '../realtime-topics.module';
import { ChatModule } from '../chat.module';
import { ChatSyncModule } from '../chat-sync.module';
import { ChatJobsModule } from '../chat-jobs.module';
import { ChatOfflineWorkerModule } from '../chat-offline-worker.module';
import { ChatProjectorModule } from '../chat-projector.module';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ChatJobs } from '../infra/chat.jobs';
import { PORTS, type LiveBusPort } from '../domain/ports';

export type { TestUser };

/** The gateway-compatible buses (`chat:channel:<id>`, `chat:moderation`): records what is published, or refuses while `down`. */
export class FakeLiveBus implements LiveBusPort {
  readonly channel: Array<{
    channelId: string;
    event: Record<string, unknown>;
  }> = [];
  readonly moderation: Array<Record<string, unknown>> = [];
  down = false;

  publishChannel(
    channelId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (this.down) return Promise.reject(new Error('live bus is down'));
    this.channel.push({ channelId, event });
    return Promise.resolve();
  }

  publishModeration(event: Record<string, unknown>): Promise<void> {
    if (this.down) return Promise.reject(new Error('live bus is down'));
    this.moderation.push(event);
    return Promise.resolve();
  }

  eventsOf(channelId: string, type?: string) {
    return this.channel
      .filter(
        (c) =>
          c.channelId === channelId &&
          (type === undefined || c.event.type === type),
      )
      .map((c) => c.event);
  }

  reset(): void {
    this.channel.length = 0;
    this.moderation.length = 0;
    this.down = false;
  }
}

/**
 * Wraps the real S51 publisher (receipts, presence): records every publish and still delivers it to the real hub, so
 * a spec can also read the event stream. While `down` it behaves as the real publisher does when its store is
 * unreachable: it resolves `published: false` after one attempt and does not throw (S51 AS-32).
 */
export class RealtimeRecorder {
  readonly published: Array<{
    topic: string;
    type: string;
    data: unknown;
    options?: unknown;
  }> = [];
  down = false;

  install(publisher: RealtimePublisher): void {
    const original = publisher.publish.bind(publisher) as (
      ...args: unknown[]
    ) => Promise<{ published: boolean; id: string | null }>;
    (publisher as unknown as { publish: unknown }).publish = (
      topic: string,
      type: string,
      data: unknown,
      options?: unknown,
    ) => {
      if (this.down) return Promise.resolve({ published: false, id: null });
      this.published.push({ topic, type, data, options });
      return original(topic, type, data, options);
    };
  }

  reset(): void {
    this.published.length = 0;
    this.down = false;
  }
}

export interface ChatTestApp extends CatalogTestApp {
  live: FakeLiveBus;
  realtime: RealtimeRecorder;
  /** The delayed offline checks land here; `drain` delivers them to the worker's handler. */
  queue: InMemoryTaskQueue;
  /** `http://127.0.0.1:<port>/api` of the listening app (for the event-stream specs). */
  baseUrl: string;
  /** The job handlers, called directly by the specs (no queue consumer starts). */
  jobs: ChatJobs;
  /** A user whose token follows `setTime`. */
  user(): Promise<TestUser>;
  /** Moves the clock; access tokens expire with it, so every user the kit made signs in again. */
  setTime(at: Date): Promise<void>;
}

/**
 * The real app the chat specs run against: `ChatModule` and `ChatSyncModule` (HTTP) next to the catalog and identity
 * APIs, over real Postgres, Redis and DynamoDB Local, with the production prefix, pipe, filter and the S50 limiter.
 * Faked only at the system edges: the live bus, the realtime hub transport and the clock (S24 test-plan.md).
 */
export async function createChatApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
  } = {},
): Promise<ChatTestApp> {
  const live = new FakeLiveBus();
  const realtime = new RealtimeRecorder();
  const queue = new InMemoryTaskQueue();
  // the specs open many streams: the connect limit is the hub's own concern (S51), not under test here
  (
    realtimeRatePolicies.policies['realtime.connect'] as { limit: number }
  ).limit = 1_000_000;
  const base = await createCatalogApp({
    extraImports: [
      ChatModule,
      ChatSyncModule,
      ChatJobsModule,
      // the worker's consumer registers on the in-memory queue; the projector's consumers are called directly
      ChatOfflineWorkerModule,
      ChatProjectorModule,
      RealtimeStreamModule,
      ChatTopicsModule,
      IdentityTopicsModule,
      ...(options.extraImports ?? []),
    ],
    overrides: [
      { provide: PORTS.LiveBusPort, useValue: live },
      // the queue validates enqueue options exactly like the real adapter and delivers on `drain` (L-001)
      { provide: TaskQueue, useValue: queue },
      ...(options.overrides ?? []),
    ],
    env: options.env,
  });
  realtime.install(base.app.get(RealtimePublisher));
  const users: TestUser[] = [];
  const port = (base.app.getHttpServer().address() as AddressInfo).port;
  return {
    ...base,
    live,
    realtime,
    queue,
    baseUrl: `http://127.0.0.1:${port}/api`,
    jobs: base.app.get(ChatJobs, { strict: false }),
    async user() {
      const user = await base.newUser();
      users.push(user);
      return user;
    },
    async setTime(at) {
      base.clock.set(at);
      for (const user of users) await base.reauth(user);
    },
    async reset() {
      live.reset();
      realtime.reset();
      users.length = 0;
      await base.reset();
    },
  };
}

// ---------------------------------------------------------------- fixtures

export interface ChatWorld {
  /** Shop owner (has `products.write`). */
  owner: TestUser;
  shop: { id: string };
  product: SeededProduct;
}

/** A shop with an owner and one product: the owner may open a chat for it. Each call creates its own shop (L-005, L-006). */
export async function seedWorld(
  t: ChatTestApp,
  product: ProductSeed = {},
): Promise<ChatWorld> {
  const owner = await t.user();
  const shop = await createShop(t.app, owner);
  const created = await createProduct(t.app, shop, product);
  return { owner, shop, product: created };
}

/** Shop staff member with `products.write` (role STAFF) or a role without it (VIEWER). */
export async function addShopMember(
  t: ChatTestApp,
  shopId: string,
  role: 'ADMIN' | 'STAFF' | 'VIEWER' = 'STAFF',
): Promise<TestUser> {
  const user = await t.user();
  await addMember(t.app, shopId, user.id, role);
  return user;
}

export interface ChannelBody {
  id: string;
  productId: string;
  shopId: string;
  sellerId: string;
  title: string;
  isArchived: boolean;
  archivedAt: string | null;
  myRole: string | null;
}

/** Opens the chat through the API as the shop owner. */
export async function openChannel(
  t: ChatTestApp,
  w: ChatWorld,
  title?: string,
): Promise<ChannelBody> {
  const res = await t
    .as(w.owner)
    .post('/api/chat/channels')
    .send({ productId: w.product.id, ...(title ? { title } : {}) });
  if (res.status !== 201)
    throw new Error(`openChannel: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as ChannelBody;
}

/** A buyer who joined the channel through the API. */
export async function joinedBuyer(
  t: ChatTestApp,
  channelId: string,
): Promise<TestUser> {
  const buyer = await t.user();
  const res = await t.as(buyer).post(`/api/chat/channels/${channelId}/join`);
  if (res.status !== 200)
    throw new Error(`join: ${res.status} ${JSON.stringify(res.body)}`);
  return buyer;
}

/** Rows of a table for assertions on persisted state (test code may read every table, IX.6). */
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

/** Forgets every rate-limit counter (a spec that repeats one user's calls many times). */
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

/** Key patterns that match everything except keys starting with `prefix` (ACL globs, as the auctions kit does). */
const patternsExcluding = (prefix: string): string[] =>
  [...prefix].map((_, i) => `${prefix.slice(0, i)}[^${prefix[i]}]*`);

export interface FastStore {
  /** The shared Redis refuses every key starting with `prefix` (an ACL rule), or accepts them again. */
  deny(prefix: string): Promise<void>;
  allow(): Promise<void>;
}

/** Breaks one keyspace of the shared Redis at its edge (the limiter's `rl:`, the presence keys) without a fake. */
export function fastStoreOf(app: INestApplication): FastStore {
  const redis = app.get(RedisService).client;
  return {
    async deny(prefix) {
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

export const newId = (): string => uuidv7();

export interface MessageBody {
  id: string;
  seq: number;
  authorId: string;
  body: string | null;
  replyToId: string | null;
  createdAt: string;
  deleted: boolean;
}

/** `POST /api/chat/channels/:channelId/messages`. */
export function sendMessage(
  t: ChatTestApp,
  user: TestUser,
  channelId: string,
  body: string,
  extra: { clientMessageId?: string; replyToId?: string } = {},
) {
  return t
    .as(user)
    .post(`/api/chat/channels/${channelId}/messages`)
    .send({
      clientMessageId: extra.clientMessageId ?? newId(),
      body,
      ...(extra.replyToId ? { replyToId: extra.replyToId } : {}),
    });
}

/** Exactly the statement the Rust gateway runs (packages/hft-platform/src/db.rs): no sequence, no client id. */
export function gatewayInsert(
  app: INestApplication,
  channelId: string,
  authorId: string,
  body: string,
) {
  return exec(
    app,
    `INSERT INTO "ChatMessage" (id, "channelId", "authorId", body, "replyToId", "createdAt") VALUES (uuidv7(), :channelId, :authorId, :body, NULL, now())`,
    { channelId, authorId, body },
  );
}
