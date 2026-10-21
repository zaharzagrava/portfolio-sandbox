import type { INestApplication } from '@nestjs/common';
import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
  testKafka,
  type LogMessage,
} from '@app/test/utils/kafka-test';
import type { FakeClock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { LinkAttributionService } from '../application/link-attribution.service';
import { FilterRebuildService } from '../application/filter-rebuild.service';
import { ShareLinkCommandService } from '../application/share-link-command.service';
import {
  CLICK_STATS_READER,
  CODE_SEQUENCE,
  DESTINATION_REPUTATION,
  DependencyUnavailableError,
  EXISTENCE_FILTER,
  LINK_CACHE,
  LINK_REPOSITORY,
  type DestinationReputation,
  type StoredLink,
} from '../domain/ports';
import { DynamoLinkRepository } from '../infra/dynamo-link.repository';
import { ClickhouseClickStatsReader } from '../infra/clickhouse-click-stats.reader';
import { LinkClicksProjector } from '../infra/link-clicks.projector';
import { RedisCodeSequence } from '../infra/redis-code-sequence';
import { RedisExistenceFilter } from '../infra/redis-existence.filter';
import { RedisLinkCache } from '../infra/redis-link.cache';
import { ShareLinksModule } from '../share-links.module';
import { ShareLinksProjectorModule } from '../share-links-projector.module';
import { ShareLinksWorkerModule } from '../share-links-worker.module';

/** Storefront origin the specs run against (the test environment's own `FRONT_HOST` is plain http). */
export const FRONT = 'https://shop.example';

export type FaultMode =
  | { kind: 'down'; times?: number }
  | { kind: 'delay'; ms: number }
  | { kind: 'hang' };

/** Dependency keys a spec can break; `dep.method` narrows the fault to one call. */
export type Dependency =
  'repo' | 'sequence' | 'filter' | 'cache' | 'stats' | 'reputation';

export interface ShareLinksTestApp extends CatalogTestApp {
  config: MockApiConfigService;
  /** Switch a dependency (or one of its methods) to failing, slow or hanging; `reset()` clears them all. */
  faults: Map<string, FaultMode>;
  /** Calls made through each wrapped port, keyed `repo.get`, `sequence.next` ... */
  calls: Map<string, number>;
  /** What the (spied) producer accepted for `links.events`, in order. */
  published: Array<{ key: string; value: any }>;
  /** Make the producer refuse (`'down'`), never answer (`'hang'`), answer after 800 ms (`'slow'`) or accept again (`null`). */
  producer(mode: 'down' | 'hang' | 'slow' | null): void;
  reputation: { verdict: 'allow' | 'block' | 'hang' };
  redis: RedisService['client'];
  user(): Promise<TestUser>;
  /** `POST /api/links` with a fresh idempotency key unless one is given. */
  create(
    user: TestUser,
    body: Record<string, unknown>,
    key?: string,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** A destination on the storefront; unique per call. */
  destination(path?: string): string;
  /** Creates a link through the API and returns its code (throws unless 201). */
  newLink(user: TestUser, body?: Record<string, unknown>): Promise<string>;
  /** `GET /api/l/:code` (no redirect following). */
  follow(code: string, headers?: Record<string, string>): any;
  /** Run the existence filter rebuild once, as the worker's job would. */
  rebuildFilter(): ReturnType<FilterRebuildService['rebuild']>;
  /** Rows of `link_clicks` for a code. */
  clickRows(code: string): Promise<Array<Record<string, any>>>;
  /** Waits until the producer spy has seen `n` events. */
  eventsFor(code: string): Array<{ key: string; value: any }>;
  /** The stored row, straight from the real repository (bypassing the faults). */
  stored(code: string): Promise<StoredLink | null>;
  /** Store a row directly (a legacy link, a planted collision, a changed destination policy). */
  plant(
    link: Partial<StoredLink> & { code: string; ownerId: string },
  ): Promise<StoredLink>;
  repository: DynamoLinkRepository;
  redisProxy: TcpFaultProxy | null;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
  logs(): Array<Record<string, any>>;
  /** Writes raw messages (objects are JSON-encoded) to `links.events`, as a producer outside the app would. */
  deliver(values: Array<object | string>, key?: string): Promise<void>;
  /** What the consumer dead-lettered so far. */
  deadLetters(): Promise<LogMessage[]>;
  /** A well-formed `link.clicked` envelope (uuidv7 ids), optionally with changed fields. */
  clickEvent(
    code: string,
    over?: {
      payload?: Record<string, unknown>;
      envelope?: Record<string, unknown>;
    },
  ): { eventId: string; payload: Record<string, any>; [k: string]: unknown };
  /** The stored item exactly as DynamoDB holds it (all attributes). */
  raw(code: string): Promise<Record<string, any> | undefined>;
  /** What the table's TTL does after `purgeAtEpoch`: remove the item (DynamoDB Local does not run the sweeper). */
  purge(code: string): Promise<void>;
  attribution: LinkAttributionService;
  commandsWith(sequence: RedisCodeSequence): ShareLinkCommandService;
  projector: LinkClicksProjector;
  /** The next unique alias-shaped code. */
  alias(prefix?: string): string;
}

function faultable<T extends object>(
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
          throw new DependencyUnavailableError(dep);
        }
        if (mode?.kind === 'hang') await new Promise(() => undefined);
        if (mode?.kind === 'delay')
          await new Promise((r) => setTimeout(r, mode.ms));
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

/**
 * The real share-link modules (HTTP, worker and projector) behind the production HTTP pipeline, with real Redis,
 * DynamoDB Local and ClickHouse. Faked at the edges only: the clock (movable), the Kafka producer (a spy that can refuse
 * or hang), the reputation port and fault-injecting wrappers around the project's own ports (L-003: every fallback is
 * forced, never assumed). Every spec creates its own users and data (L-005, L-006).
 */
export async function createShareLinksApp(
  options: {
    /** Put a fault proxy in front of the shared Redis (the limiter's, the filter's and the cache's store). */
    redisProxy?: boolean;
    /** Run the real click consumer (S53 runner) against a freshly created `links.events` topic. */
    consumer?: boolean;
    /** Run the production JSON logger and capture its stdout lines (`logs()`, `rawLogs()`). */
    structuredLogger?: boolean;
  } = {},
): Promise<ShareLinksTestApp> {
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
    ? await TcpFaultProxy.start({
        host: 'localhost',
        port: Number(
          new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').port ||
            6400,
        ),
      })
    : null;
  if (options.consumer) {
    await deleteTopicsMatching(/^(links\.events|link-clicks\.dlq)$/);
    await createTopics([{ topic: 'links.events' }]);
  }
  const faults = new Map<string, FaultMode>();
  const calls = new Map<string, number>();
  const reputation: ShareLinksTestApp['reputation'] = { verdict: 'allow' };
  const clockHolder: { clock?: FakeClock } = {};

  const base = await createCatalogApp({
    structuredLogger: options.structuredLogger,
    ...(redisProxy && {
      redisUrl: `redis://127.0.0.1:${redisProxy.port}/${new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').pathname.slice(1) || '0'}`,
    }),
    extraImports: [
      ShareLinksModule,
      ShareLinksWorkerModule,
      ShareLinksProjectorModule,
      ...(options.consumer
        ? [
            ProjectionsModule.forProjectors(
              ShareLinksProjectorModule.projectors,
              [ShareLinksProjectorModule],
            ),
          ]
        : []),
    ],
    customize: (builder) =>
      builder
        .overrideProvider(TimeSource)
        .useValue({ overrideMs: () => clockHolder.clock?.nowMs() ?? null })
        .overrideProvider(LINK_REPOSITORY)
        .useFactory({
          factory: (repo: DynamoLinkRepository) =>
            faultable('repo', repo, faults, calls),
          inject: [DynamoLinkRepository],
        })
        .overrideProvider(CODE_SEQUENCE)
        .useFactory({
          factory: (sequence: RedisCodeSequence) =>
            faultable('sequence', sequence, faults, calls),
          inject: [RedisCodeSequence],
        })
        .overrideProvider(EXISTENCE_FILTER)
        .useFactory({
          factory: (filter: RedisExistenceFilter) =>
            faultable('filter', filter, faults, calls),
          inject: [RedisExistenceFilter],
        })
        .overrideProvider(LINK_CACHE)
        .useFactory({
          factory: (cache: RedisLinkCache) =>
            faultable('cache', cache, faults, calls),
          inject: [RedisLinkCache],
        })
        .overrideProvider(CLICK_STATS_READER)
        .useFactory({
          factory: (reader: ClickhouseClickStatsReader) =>
            faultable('stats', reader, faults, calls),
          inject: [ClickhouseClickStatsReader],
        })
        .overrideProvider(DESTINATION_REPUTATION)
        .useValue(
          faultable<DestinationReputation>(
            'reputation',
            {
              check: async () => {
                if (reputation.verdict === 'hang')
                  await new Promise(() => undefined);
                return reputation.verdict === 'block' ? 'block' : 'allow';
              },
            },
            faults,
            calls,
          ),
        ),
  });
  clockHolder.clock = base.clock;
  const app: INestApplication = base.app;
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const redis = app.get(RedisService).client;
  const clickhouse = app.get(ClickHouseService);
  const repository = app.get(DynamoLinkRepository);

  // L-011: the analytics tables exist in the test stack whatever order the stack was prepared in
  await applyClickHouseDdl(clickhouse, '020_link_clicks.sql');
  // Allocate the filter's 114 MiB bit array up front: the first SETBIT on a missing key outlasts the 150 ms timeout.
  await redis.setbit('share-links:bloom', 958_000_000, 0);

  const published: ShareLinksTestApp['published'] = [];
  const producer = app.get(KafkaProducerService);
  let producerMode: 'down' | 'hang' | 'slow' | null = null;
  const send = jest
    .spyOn(producer, 'send')
    .mockImplementation(async (message: any) => {
      if (producerMode === 'down') throw new Error('broker down (injected)');
      if (producerMode === 'hang') await new Promise(() => undefined);
      if (producerMode === 'slow') await new Promise((r) => setTimeout(r, 800));
      published.push({ key: message.key, value: message.value });
    });

  let counter = 0;
  const configure = () => {
    config.set('front_host', FRONT);
    config.set('share_link_max_per_owner', 1000);
  };
  configure();

  const t: ShareLinksTestApp = {
    ...base,
    config,
    faults,
    calls,
    published,
    reputation,
    redis,
    repository,
    attribution: app.get(LinkAttributionService),
    projector: app.get(LinkClicksProjector),
    producer: (mode) => {
      producerMode = mode;
    },
    redisProxy,
    async deliver(values, key = 'k') {
      const kafka = testKafka().producer();
      await kafka.connect();
      try {
        await kafka.send({
          topic: 'links.events',
          messages: values.map((v) => ({
            key,
            value: typeof v === 'string' ? v : JSON.stringify(v),
          })),
        });
      } finally {
        await kafka.disconnect();
      }
    },
    deadLetters: () => readTopic('link-clicks.dlq'),
    clickEvent(code, over = {}) {
      const clickId = uuidv7();
      const at = base.clock.now().toISOString();
      return {
        eventId: clickId,
        type: 'link.clicked',
        version: 1,
        aggregateType: 'links',
        aggregateId: code,
        aggregateVersion: 1,
        occurredAt: at,
        payload: {
          clickId,
          code,
          ts: at,
          country: 'DE',
          referer: '',
          viaEdge: false,
          ...over.payload,
        },
        ...over.envelope,
      };
    },
    rawLogs: () => logChunks.join(''),
    logs: () =>
      logChunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, any>),
    close: async () => {
      send.mockRestore();
      stdoutSpy?.mockRestore();
      await base.close();
      await redisProxy?.close();
    },
    async raw(code) {
      const { Item } = await app.get(DynamoService).doc.send(
        new GetCommand({
          TableName: app.get(DynamoService).table('Links'),
          Key: { code },
          ConsistentRead: true,
        }),
      );
      return Item;
    },
    async purge(code) {
      const dynamo = app.get(DynamoService);
      await dynamo.doc.send(
        new DeleteCommand({ TableName: dynamo.table('Links'), Key: { code } }),
      );
    },
    async reset() {
      if (redisProxy) redisProxy.mode = 'pass';
      await base.reset();
      config.reset();
      configure();
      faults.clear();
      calls.clear();
      published.length = 0;
      producerMode = null;
      reputation.verdict = 'allow';
      // The filter's bit array (114 MiB) stays allocated between specs: stale bits only cause false "maybe" answers,
      // while re-allocating it on every first add would outlast the filter's 150 ms timeout.
      const keys = [
        ...(await redis.keys('share-links:*')).filter(
          (key) => key !== 'share-links:bloom',
        ),
        ...(await redis.keys('link:v1:*')),
      ];
      if (keys.length) await redis.del(...keys);
      await clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE link_clicks' });
    },
    user: () => base.newUser(),
    create: (user, body, key = uuidv4()) =>
      base.as(user).post('/api/links').set('Idempotency-Key', key).send(body),
    destination: (path = `/p/${uuidv4().slice(0, 8)}`) => `${FRONT}${path}`,
    async newLink(user, body = {}) {
      // Set-up helper: the stores' 150 ms timers can trip when the test process is busy with a consumer or a burst; the
      // same idempotency key makes the retry safe, and a specification of create's own failures uses `create`.
      const key = uuidv4();
      const payload = { destination: t.destination(), ...body };
      let res = await t.create(user, payload, key);
      for (let attempt = 0; res.status === 503 && attempt < 3; attempt++)
        res = await t.create(user, payload, key);
      if (res.status !== 201)
        throw new Error(
          `create link: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body.code as string;
    },
    follow: (code, headers = {}) => {
      let req = base.http().get(`/api/l/${code}`);
      for (const [name, value] of Object.entries(headers))
        req = req.set(name, value);
      return req;
    },
    rebuildFilter: () => app.get(FilterRebuildService).rebuild(),
    async clickRows(code) {
      return clickhouse.query(
        'SELECT click_id, code, toString(ts) AS ts, country, referer, via_edge FROM link_clicks WHERE code = {code:String} ORDER BY ts',
        { code },
      );
    },
    eventsFor: (code) => published.filter((m) => m.key === code),
    stored: (code) => repository.get(code),
    async plant(link) {
      const now = base.clock.now().toISOString();
      const row: StoredLink = {
        kind: 'custom',
        destination: `${FRONT}/p/planted`,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        ...link,
      };
      const outcome = await repository.create(row, 1_000_000, now);
      if (outcome !== 'created') throw new Error(`plant: ${outcome}`);
      return row;
    },
    commandsWith: (sequence) => {
      const live = app.get(ShareLinkCommandService) as any;
      return new ShareLinkCommandService(
        live.links,
        sequence,
        live.filter,
        live.cache,
        live.reputation,
        live.clock,
        config,
      );
    },
    alias: (prefix = 'promo') =>
      `${prefix}-${(++counter).toString(36)}${uuidv4().slice(0, 6)}`.replace(
        /[^a-z0-9-]/g,
        '',
      ),
  };
  return t;
}
