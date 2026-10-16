import { Module, type INestApplication, type Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4 } from 'uuid';
import type { z } from 'zod';
import { Logger as PinoLogger } from 'nestjs-pino';
import { LoggingModule } from '@app/common/logging/logging.module';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ProductQueryModule } from '@app/domains/catalog';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import {
  ManualTimeSource,
  TimeSource,
} from '@app/infrastructure/rate-limit/time-source';
import {
  RealtimePublisher,
  RealtimeStreamModule,
  TopicSubscriber,
} from '@app/infrastructure/realtime';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { IdentityTopicsModule, Role } from '@app/domains/identity';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { issueSession } from '@app/test/seeds/session.fixture';
import { openSse, type OpenSse } from '@app/test/utils/sse-client';
import { waitFor } from '@app/test/utils/async-helpers';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import type {
  LiveComment,
  LiveSnapshotDto,
  LiveStreamDto,
} from '@marketplace-sandbox/contracts';
import { LiveStateCache } from '../application/live-state-cache';
import { ACTIVE_STREAMS } from '../domain/live-keys';
import {
  ACTIVE_STREAM_SET,
  CLIENT_IDS,
  COMMENT_FEED,
  COMMENT_HISTORY_READER,
  LIVE_SETTINGS,
  LIVE_TIMERS,
  MUTE_CACHE,
  REACTION_COUNTERS,
  RECENT_COMMENT_STORE,
  REMOVAL_CLAIMS,
  TICKER_COORDINATION,
  TOXICITY_CLASSIFIER,
  VIEWER_COUNTS,
  type CommentFeed,
  type LiveSettings,
  type LiveTimers,
  type ReactionCounters,
  type ToxicityClassifier,
  type ViewerCounts,
} from '../domain/live-ports';
import { LiveViewerRegistry } from '../gateway/live-viewer-registry';
import { LiveCommentsProjector } from '../infra/live-comments.projector';
import { LiveModerationConsumer } from '../infra/live-moderation.consumer';
import { LiveReconcileJob } from '../infra/live-reconcile.job';
import { LiveTicker } from '../infra/live-ticker.service';
import { LiveGatewayModule } from '../live-gateway.module';
import { LiveProjectorModule } from '../live-projector.module';
import { LiveTopicsModule } from '../live-topics.module';
import { LiveWorkerModule } from '../live-worker.module';
import { LiveModule } from '../live.module';

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export interface Actor {
  id: string;
  email: string;
  auth: Record<string, string>;
}
export interface Seller extends Actor {
  shopId: string;
}

/** A store port instrumented in place: every call is recorded and the whole port can be switched off (fault injection). */
export interface StoreSwitch {
  readonly name: string;
  calls: string[];
  isDown: boolean;
  /** Method names that throw while `isDown` is false (a fault at one step only). */
  failing: Set<string>;
  down(): void;
  up(): void;
  reset(): void;
  count(method?: string): number;
}

function makeSwitch(name: string): StoreSwitch {
  const control: StoreSwitch = {
    name,
    calls: [],
    isDown: false,
    failing: new Set(),
    down() {
      control.isDown = true;
    },
    up() {
      control.isDown = false;
      control.failing.clear();
    },
    reset() {
      control.calls.length = 0;
    },
    count(method) {
      return method
        ? control.calls.filter((c) => c === method).length
        : control.calls.length;
    },
  };
  return control;
}

/** Wraps every method of `port` (own prototype chain, not instance fields) so `control` can fail it. */
function instrument(port: object, control: StoreSwitch): void {
  const names = new Set<string>();
  const ownFields = new Set(Object.getOwnPropertyNames(port));
  for (
    let proto: object | null = Object.getPrototypeOf(port);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const key of Object.getOwnPropertyNames(proto))
      if (
        key !== 'constructor' &&
        !ownFields.has(key) &&
        typeof (port as Record<string, unknown>)[key] === 'function'
      )
        names.add(key);
  for (const key of names) {
    const original = (port as Record<string, (...a: unknown[]) => unknown>)[
      key
    ];
    (port as Record<string, unknown>)[key] = (...args: unknown[]) => {
      control.calls.push(key);
      if (control.isDown || control.failing.has(key))
        return Promise.reject(new Error(`${control.name} is down`));
      return original.apply(port, args);
    };
  }
}

/** The toxicity classifier, faked at the system edge: scores by text, slow or failing on demand. */
export class FakeClassifier implements ToxicityClassifier {
  scores = new Map<string, number>();
  mode: 'ok' | 'hang' | 'fail' = 'ok';
  calls: string[] = [];
  score(text: string): Promise<number> {
    this.calls.push(text);
    if (this.mode === 'fail')
      return Promise.reject(new Error('classifier down'));
    if (this.mode === 'hang') return new Promise(() => undefined);
    return Promise.resolve(this.scores.get(text) ?? 0);
  }
  reset() {
    this.scores.clear();
    this.mode = 'ok';
    this.calls = [];
  }
}

/** Timers driven by hand: a window, a keep-alive or a tick happens when the spec says so, never by waiting. */
export class ManualTimers implements LiveTimers {
  private now = 0;
  private readonly tasks = new Set<{
    ms: number;
    due: number;
    fn: () => void;
  }>();

  every(ms: number, fn: () => void): () => void {
    const task = { ms, due: this.now + ms, fn };
    this.tasks.add(task);
    return () => void this.tasks.delete(task);
  }

  /** Moves the manual time forward; every task that falls due runs, in order, as often as it falls due. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.tasks]
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.now = next.due;
      next.due += next.ms;
      next.fn();
    }
    this.now = target;
  }

  get active(): number {
    return this.tasks.size;
  }
}

export interface Published {
  topic: string;
  type: string;
  data: Record<string, unknown>;
}

/** What the live specs need from a booted app. */
export interface LiveTestApp {
  app: INestApplication;
  baseUrl: string;
  clock: FakeClock;
  db: Sequelize;
  settings: LiveSettings;
  timers: ManualTimers;
  classifier: FakeClassifier;
  stores: Record<
    'events' | 'fast' | 'outbox' | 'history' | 'limiter',
    StoreSwitch
  >;
  /** Realtime publishes since the last `reset()` (control events). */
  published: Published[];
  /** Events sent to the event stream since the last `reset()`. */
  sent: EventEnvelope[];
  /** Number of relational statements the app issued since the last `resetQueries()`. */
  queries: { count: number; sql: string[] };
  /** DynamoDB `UpdateItem` calls in flight at most at once, and throttling on demand. */
  historyIo: {
    calls: number;
    maxParallel: number;
    throttleNext(n: number): void;
  };
  history: LiveCommentsProjector;
  moderation: LiveModerationConsumer;
  reconcile: LiveReconcileJob;
  ticker: LiveTicker;
  /** Another statistics publisher, as a second worker instance. */
  newTicker(): LiveTicker;
  registry: LiveViewerRegistry;
  state: LiveStateCache;
  counters: ReactionCounters;
  viewerCounts: ViewerCounts;
  /** The private comment feed the gateways read (volume specs publish to it directly). */
  feed: CommentFeed;
  http: () => ReturnType<typeof supertest>;
  advance(ms: number): Promise<void>;
  /** Closes one delivery window of every stream on the manual timers. */
  window(): void;
  logLines(): string;
  reset(): Promise<void>;
  // --- actors and fixtures ---
  seller(options?: {
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  }): Promise<Seller>;
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<Actor>;
  viewer(): Promise<Actor>;
  viewers(n: number): Promise<Actor[]>;
  product(
    shopId: string,
    overrides?: { status?: 'ACTIVE' | 'ARCHIVED'; title?: string },
  ): Promise<{ id: string; title: string }>;
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  outbox(aggregateId: string): ReturnType<typeof outboxRowsFor>;
  // --- scenario helpers ---
  createStream(
    s: Seller,
    body?: Record<string, unknown>,
  ): Promise<LiveStreamDto>;
  /** Creates and starts a stream. */
  liveStream(s: Seller): Promise<LiveStreamDto>;
  start(s: Seller, streamId: string): supertest.Test;
  end(s: Seller, streamId: string): supertest.Test;
  pin(
    s: Actor & { shopId: string },
    streamId: string,
    body: object,
  ): supertest.Test;
  unpin(s: Actor & { shopId: string }, streamId: string): supertest.Test;
  removeComment(
    s: Actor & { shopId: string },
    streamId: string,
    commentId: string,
  ): supertest.Test;
  mute(
    s: Actor & { shopId: string },
    streamId: string,
    userId: string,
  ): supertest.Test;
  unmute(
    s: Actor & { shopId: string },
    streamId: string,
    userId: string,
  ): supertest.Test;
  comment(
    streamId: string,
    who: Actor | null,
    body: string | Record<string, unknown>,
  ): supertest.Test;
  react(
    streamId: string,
    who: Actor | null,
    reactions: Record<string, unknown>,
  ): supertest.Test;
  snapshot(streamId: string): supertest.Test;
  history_(streamId: string, query?: string): supertest.Test;
  /** Opens the event connection (headers arrived); the spec closes it. */
  connect(streamId: string, who?: Actor | null): Promise<OpenSse>;
  /** Waits until the gateway has received `n` comments of the stream from the feed. */
  fed(streamId: string, n: number): Promise<void>;
  /** Removes the rate-limit windows of the live policies (every spec calls from one address). */
  resetLimits(): Promise<void>;
  close(): Promise<void>;
}

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

/** The problem document every error carries (S54 FR-001). */
export function expectProblem(body: unknown): {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: { field: string; code: string }[];
  reason?: string;
} {
  const p = body as Record<string, unknown>;
  for (const key of [
    'type',
    'title',
    'detail',
    'instance',
    'code',
    'requestId',
  ])
    if (typeof p?.[key] !== 'string' || (p[key] as string).length === 0)
      throw new Error(
        `problem document lacks "${key}": ${JSON.stringify(body)}`,
      );
  if (typeof p.status !== 'number' || p.status < 400)
    throw new Error(`problem document has no status: ${JSON.stringify(body)}`);
  for (const internal of ['area', 'data', 'causes'])
    if (internal in p)
      throw new Error(`problem document exposes "${internal}"`);
  return p as never;
}

export interface LiveAppOptions {
  captureLogs?: boolean;
  settings?: Partial<LiveSettings>;
  /** `real`: events also go to the broker (the projector specs read them back). Default: recorded only. */
  broker?: 'record' | 'real';
  /** Starts the two consumers through the real consumer framework (needs `broker: 'real'`); default: called by hand. */
  framework?: boolean;
  /** Extra modules (for example the realtime stream endpoint is always included). */
  extraImports?: unknown[];
}

@Module({
  imports: [LiveProjectorModule],
  providers: [LiveCommentsProjector, LiveModerationConsumer],
  exports: [LiveCommentsProjector, LiveModerationConsumer],
})
class LiveConsumersProbeModule {}

const GATEWAY_PORTS = [
  RECENT_COMMENT_STORE,
  COMMENT_FEED,
  MUTE_CACHE,
  REACTION_COUNTERS,
  VIEWER_COUNTS,
  ACTIVE_STREAM_SET,
  CLIENT_IDS,
  REMOVAL_CLAIMS,
  TICKER_COORDINATION,
  COMMENT_HISTORY_READER,
];

export async function createLiveApp(
  options: LiveAppOptions = {},
): Promise<LiveTestApp> {
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
  const limiterTime = new ManualTimeSource(clock.nowMs());
  const timers = new ManualTimers();
  const classifier = new FakeClassifier();
  const settings: LiveSettings = {
    windowMs: 250,
    sampleSize: 5,
    viewerCap: 50_000,
    moderationThreshold: 0.7,
    ...options.settings,
  };

  const moduleRef = await generateTestingModule(
    [
      LiveModule,
      LiveWorkerModule,
      options.framework
        ? ProjectionsModule.forProjectors(LiveProjectorModule.projectors, [
            LiveProjectorModule,
          ])
        : LiveConsumersProbeModule,
      LiveGatewayModule,
      LiveTopicsModule,
      RealtimeStreamModule,
      IdentityTopicsModule,
      ProductQueryModule,
      SeedsModule,
      ...(options.captureLogs ? [LoggingModule] : []),
      ...((options.extraImports ?? []) as Type[]),
    ],
    {
      stores: ['redis', 'dynamo'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(TimeSource)
          .useValue(limiterTime)
          .overrideProvider(LIVE_TIMERS)
          .useValue(timers)
          .overrideProvider(LIVE_SETTINGS)
          .useValue(settings)
          .overrideProvider(TOXICITY_CLASSIFIER)
          .useValue(classifier),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, {
    useStructuredLogger: options.captureLogs === true,
    processHandlers: false,
  });
  await app.listen(0, '127.0.0.1');
  if (options.captureLogs) app.useLogger(app.get(PinoLogger));
  const port = (app.getHttpServer().address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const db: Sequelize = app.get(getConnectionToken());
  const rawQuery = db.query.bind(db);
  const queries = {
    n: 0,
    sql: [] as string[],
    // Setting the count to 0 starts a new measurement (the statements recorded so far go too).
    get count() {
      return queries.n;
    },
    set count(value: number) {
      queries.n = value;
      if (value === 0) queries.sql.length = 0;
    },
  };
  (db as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queries.n++;
    queries.sql.push(
      String(
        typeof args[0] === 'string'
          ? args[0]
          : ((args[0] as { query?: string })?.query ?? ''),
      ).slice(0, 160),
    );
    return (rawQuery as (...a: unknown[]) => unknown)(...args);
  };
  const http = () => supertest(app.getHttpServer());
  const redis = app.get(RedisService);

  // --- fault injection at the system edge -------------------------------------------------------------------------
  const stores = {
    events: makeSwitch('events'),
    fast: makeSwitch('fast'),
    outbox: makeSwitch('outbox'),
    history: makeSwitch('history'),
    limiter: makeSwitch('limiter'),
  };
  const modules: Type[] = [
    LiveModule,
    LiveWorkerModule,
    LiveProjectorModule,
    LiveGatewayModule,
  ];
  const providersOf = (token: symbol): object[] =>
    modules.flatMap((module) => {
      try {
        return [app.select(module).get<object>(token, { strict: true })];
      } catch {
        return [];
      }
    });
  for (const token of GATEWAY_PORTS)
    for (const port of providersOf(token)) instrument(port, stores.fast);
  instrument(app.get(TopicSubscriber), stores.fast);
  instrument(app.get(RateLimiterService), stores.limiter);

  const sent: EventEnvelope[] = [];
  // The event stream and the outbox are wrapped on the class (a dynamic module registered with other arguments has its own
  // publisher instance); the originals come back when the app closes.
  const restore: (() => void)[] = [];
  const publisherProto = EventPublisher.prototype;
  const realPublishMany = publisherProto.publishMany;
  publisherProto.publishMany = async function (
    this: EventPublisher,
    envelopes: EventEnvelope[],
  ) {
    stores.events.calls.push('publishMany');
    if (stores.events.isDown) throw new Error('events is down');
    sent.push(...envelopes);
    if (options.broker === 'real') await realPublishMany.call(this, envelopes);
  };
  restore.push(() => (publisherProto.publishMany = realPublishMany));
  const outboxProto = OutboxService.prototype;
  const realAppend = outboxProto.append;
  outboxProto.append = function (
    this: OutboxService,
    ...args: Parameters<OutboxService['append']>
  ) {
    stores.outbox.calls.push('append');
    if (stores.outbox.isDown)
      return Promise.reject(new Error('outbox is down'));
    return realAppend.apply(this, args);
  };
  restore.push(() => (outboxProto.append = realAppend));

  const published: Published[] = [];
  const publisher = app.get(RealtimePublisher);
  const realPublish = publisher.publish.bind(publisher);
  publisher.publish = ((
    topic: string,
    type: string,
    data: unknown,
    opts?: object,
  ) => {
    published.push({ topic, type, data: data as Record<string, unknown> });
    return realPublish(topic as never, type, data, opts);
  }) as typeof publisher.publish;

  // DynamoDB: count UpdateItem calls and let a spec throttle the next ones (the store says no, the writer retries).
  const dynamo = app.get(DynamoService);
  const realSend = dynamo.doc.send.bind(dynamo.doc);
  const historyIo = {
    calls: 0,
    maxParallel: 0,
    inFlight: 0,
    throttle: 0,
    throttleNext(n: number) {
      historyIo.throttle = n;
    },
  };
  (dynamo.doc as unknown as { send: unknown }).send = async (
    command: object,
  ) => {
    if (command.constructor.name === 'UpdateCommand') {
      historyIo.calls++;
      stores.history.calls.push('update');
      historyIo.inFlight++;
      historyIo.maxParallel = Math.max(
        historyIo.maxParallel,
        historyIo.inFlight,
      );
      try {
        if (stores.history.isDown) throw new Error('history is down');
        if (historyIo.throttle > 0) {
          historyIo.throttle--;
          const error = new Error('throttled');
          error.name = 'ProvisionedThroughputExceededException';
          throw error;
        }
        // Let neighbours start before this one finishes, so the width of a group is visible.
        await new Promise((resolve) => setImmediate(resolve));
        return await (realSend as (c: object) => Promise<unknown>)(command);
      } finally {
        historyIo.inFlight--;
      }
    }
    return (realSend as (c: object) => Promise<unknown>)(command);
  };

  // --- actors -----------------------------------------------------------------------------------------------------
  const actors: { actor: Actor; role: Role; issuedAtMs: number }[] = [];
  const user = async (role = Role.USER): Promise<Actor> => {
    const email = `live-${v4()}@mail.com`;
    const created = await createUser(app, { email, role });
    const { bearer } = await issueSession(app, created);
    const actor = { id: created.id, email, auth: { Authorization: bearer } };
    actors.push({ actor, role, issuedAtMs: clock.nowMs() });
    return actor;
  };
  // An access token lives 300 s of the (fake) clock; only tokens close to their end are signed again when time moves.
  const resign = async () => {
    const stale = actors.filter((a) => clock.nowMs() - a.issuedAtMs > 150_000);
    for (let i = 0; i < stale.length; i += 25)
      await Promise.all(
        stale.slice(i, i + 25).map(async (entry) => {
          const session = await issueSession(app, {
            id: entry.actor.id,
            role: entry.role,
          });
          entry.actor.auth.Authorization = session.bearer;
          entry.issuedAtMs = clock.nowMs();
        }),
      );
  };
  const asAuth = (who: Actor | null): Record<string, string> =>
    who ? who.auth : {};

  const worker = app.select(LiveWorkerModule);
  const t: LiveTestApp = {
    app,
    baseUrl,
    clock,
    db,
    settings,
    timers,
    classifier,
    stores,
    published,
    sent,
    queries,
    historyIo,
    history: app.get(LiveCommentsProjector, { strict: false }),
    moderation: app.get(LiveModerationConsumer, { strict: false }),
    reconcile: worker.get(LiveReconcileJob, { strict: true }),
    ticker: worker.get(LiveTicker, { strict: true }),
    newTicker: () => {
      const first = worker.get(LiveTicker, { strict: true }) as unknown as {
        active: never;
        coordination: never;
        counters: never;
        viewers: never;
        state: never;
        realtime: never;
        events: never;
        timers: never;
        clock: never;
      };
      return new LiveTicker(
        first.active,
        first.coordination,
        first.counters,
        first.viewers,
        first.state,
        first.realtime,
        first.events,
        { every: () => () => undefined },
        first.clock,
      );
    },
    registry: app
      .select(LiveGatewayModule)
      .get(LiveViewerRegistry, { strict: true }),
    state: app.select(LiveModule).get(LiveStateCache, { strict: true }),
    counters: worker.get<ReactionCounters>(REACTION_COUNTERS, { strict: true }),
    viewerCounts: worker.get<ViewerCounts>(VIEWER_COUNTS, { strict: true }),
    feed: app
      .select(LiveModule)
      .get<CommentFeed>(COMMENT_FEED, { strict: true }),
    http,
    advance: async (ms) => {
      clock.advance(ms);
      limiterTime.advance(ms);
      await resign();
    },
    window: () => timers.advance(settings.windowMs),
    logLines: () => logs.join(''),
    reset: async () => {
      published.length = 0;
      sent.length = 0;
      queries.count = 0;
      queries.sql.length = 0;
      for (const s of Object.values(stores)) {
        s.up();
        s.reset();
      }
      classifier.reset();
      historyIo.calls = 0;
      historyIo.maxParallel = 0;
      historyIo.throttle = 0;
      await redis.client.del(ACTIVE_STREAMS);
      await t.resetLimits();
    },
    seller: async (opts = {}) => {
      const owner = await user();
      const shop = await createShop(app, owner, {
        name: 'Live Shop',
        slug: `shop-${v4().slice(0, 8)}`,
        ...(opts.status ? { status: opts.status } : {}),
      });
      return { ...owner, shopId: shop.id as string };
    },
    member: async (shopId, role) => {
      const created = await user();
      await addMember(app, shopId, created.id, role);
      return created;
    },
    viewer: () => user(),
    viewers: (n) => Promise.all(Array.from({ length: n }, () => user())),
    product: async (shopId, overrides = {}) => {
      const p = await createProduct(
        app,
        { id: shopId },
        { status: overrides.status, title: overrides.title },
      );
      return { id: p.id, title: p.title };
    },
    rows: (sql, replacements = {}) =>
      rawQuery(sql, {
        type: QueryTypes.SELECT,
        replacements,
      }) as Promise<never>,
    outbox: (aggregateId) => outboxRowsFor(app, aggregateId),
    createStream: async (s, body = { title: 'Product reveal' }) => {
      const res = await http()
        .post(`/api/shops/${s.shopId}/live`)
        .set(s.auth)
        .send(body);
      if (res.status !== 201)
        throw new Error(
          `create stream: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body as LiveStreamDto;
    },
    liveStream: async (s) => {
      const stream = await t.createStream(s);
      const res = await t.start(s, stream.id);
      if (res.status !== 200)
        throw new Error(
          `start stream: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body as LiveStreamDto;
    },
    start: (s, id) =>
      http().post(`/api/shops/${s.shopId}/live/${id}/start`).set(s.auth),
    end: (s, id) =>
      http().post(`/api/shops/${s.shopId}/live/${id}/end`).set(s.auth),
    pin: (s, id, body) =>
      http()
        .put(`/api/shops/${s.shopId}/live/${id}/pin`)
        .set(s.auth)
        .send(body),
    unpin: (s, id) =>
      http().delete(`/api/shops/${s.shopId}/live/${id}/pin`).set(s.auth),
    removeComment: (s, id, commentId) =>
      http()
        .delete(`/api/shops/${s.shopId}/live/${id}/comments/${commentId}`)
        .set(s.auth),
    mute: (s, id, userId) =>
      http()
        .post(`/api/shops/${s.shopId}/live/${id}/mutes/${userId}`)
        .set(s.auth),
    unmute: (s, id, userId) =>
      http()
        .delete(`/api/shops/${s.shopId}/live/${id}/mutes/${userId}`)
        .set(s.auth),
    comment: (streamId, who, body) =>
      http()
        .post(`/api/live/${streamId}/comments`)
        .set(asAuth(who))
        .send(typeof body === 'string' ? { text: body } : body),
    react: (streamId, who, reactions) =>
      http()
        .post(`/api/live/${streamId}/reactions`)
        .set(asAuth(who))
        .send({ reactions }),
    snapshot: (streamId) => http().get(`/api/live/${streamId}`),
    history_: (streamId, query = '') =>
      http().get(`/api/live/${streamId}/history${query}`),
    connect: (streamId, who = null) =>
      openSse(`${baseUrl}/live/${streamId}/events`, { headers: asAuth(who) }),
    fed: async (streamId, n) => {
      await waitFor(
        () =>
          Promise.resolve((t.registry.batcher(streamId)?.received ?? 0) >= n),
        { timeoutMs: 10_000, intervalMs: 10, description: `${n} comments fed` },
      );
    },
    resetLimits: async () => {
      const keys = await redis.client.keys('rl:{live.*');
      if (keys.length > 0) await redis.client.del(...keys);
    },
    close: async () => {
      writeSpy?.mockRestore();
      jest.restoreAllMocks();
      restore.forEach((fn) => fn());
      await app.close();
    },
  };
  await t.reset();
  return t;
}

export type { LiveComment, LiveSnapshotDto, LiveStreamDto, OpenSse };
export { MetricsRegistry };
