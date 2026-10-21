import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Role } from '@app/domains/identity';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
  type LogMessage,
} from '@app/test/utils/kafka-test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsModule } from '../analytics.module';
import { ANALYTICS_TOPIC } from '../domain/event-schema';
import { shardName } from '@app/common/shard';

/** The frozen "now" of the S39 specs. */
export const T0 = new Date('2026-10-14T12:00:00.000Z');

export const chTime = (ms: number | Date): string =>
  new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** Empties and recreates the real topic so a spec starts with a log nobody else wrote to (L-006). */
export async function freshAnalyticsTopic(): Promise<void> {
  await deleteTopicsMatching(/^analytics\.events$/);
  await createTopics([{ topic: ANALYTICS_TOPIC }]);
}

/**
 * Creates the analytical store objects of `072_analytics_dedupe.sql` in the test ClickHouse. Without `stream` only the tables
 * are made (no Kafka-engine queue and views); with it the queue reads the real test broker, whose address inside the compose
 * network is not the dev stack's. `dropAnalyticsStream` removes what `stream` created (L-013).
 */
export async function applyAnalyticsStore(
  clickhouse: ClickHouseService,
  options: { stream?: boolean } = {},
): Promise<void> {
  const sql = readFileSync(
    join(process.cwd(), 'clickhouse/072_analytics_dedupe.sql'),
    'utf8',
  );
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean);
  for (const statement of statements) {
    const streaming =
      /analytics_events_queue|analytics_events_mv|analytics_events_errors_mv/.test(
        statement,
      );
    if (streaming && !options.stream) continue;
    await clickhouse.getClient().command({
      // the Kafka engine talks to the broker itself, past the shard wrapper: give it the shard's topic and group names
      query: statement
        .replace('kafka:29092', 'test_kafka:29192')
        .replace("'analytics.events'", `'${shardName('analytics.events')}'`)
        .replace(
          "'clickhouse-analytics'",
          `'${shardName('clickhouse-analytics')}'`,
        ),
    });
  }
}

export async function dropAnalyticsStream(
  clickhouse: ClickHouseService,
): Promise<void> {
  for (const query of [
    'DROP VIEW IF EXISTS analytics_events_mv',
    'DROP VIEW IF EXISTS analytics_events_errors_mv',
    'DROP TABLE IF EXISTS analytics_events_queue',
  ])
    await clickhouse.getClient().command({ query });
}

/** A row of `analytics_event_log` as the stream would have written it. */
export interface StoredRow {
  event_id: string;
  name: string;
  anonymous_id: string;
  user_id: string;
  ts: string;
  received_at: string;
  country: string;
  platform: string;
  page: string;
  props: Record<string, string>;
}

let rowCounter = 0;
/** A stored row with a fresh id; `ts` and `received_at` take milliseconds or dates. */
export function storedRow(
  patch: Partial<Omit<StoredRow, 'ts' | 'received_at'>> & {
    ts?: number | Date;
    received_at?: number | Date;
  } = {},
): StoredRow {
  rowCounter += 1;
  const { ts, received_at, ...rest } = patch;
  return {
    event_id: uuidv4(),
    name: 'page_view',
    anonymous_id: `anon-row-${rowCounter}-${uuidv4().slice(0, 8)}`,
    user_id: '',
    country: '',
    platform: 'web',
    page: '',
    props: {},
    ...rest,
    ts: chTime(ts ?? T0),
    received_at: chTime(received_at ?? ts ?? T0),
  };
}

/** Writes rows straight into the store (a delivery the stream would have made), in chunks. */
export async function insertRows(
  clickhouse: ClickHouseService,
  rows: StoredRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 5_000)
    await clickhouse.getClient().insert({
      table: 'analytics_event_log',
      values: rows.slice(i, i + 5_000),
      format: 'JSONEachRow',
    });
}

export async function truncateAnalyticsStore(
  clickhouse: ClickHouseService,
): Promise<void> {
  for (const table of ['analytics_event_log', 'analytics_events_errors'])
    await clickhouse.getClient().command({ query: `TRUNCATE TABLE ${table}` });
}

export interface PostOptions {
  user?: TestUser;
  headers?: Record<string, string>;
  /** `text/plain` is what `navigator.sendBeacon` sends. */
  contentType?: string;
  /** Sent as it is instead of `JSON.stringify(body)`. */
  raw?: string | Buffer;
  /** The caller's address; by default every request comes from an address of its own, so no spec spends another's budget. */
  ip?: string;
}

let addressCounter = 0;
const nextAddress = (): string => {
  addressCounter += 1;
  return `10.${(addressCounter >> 16) & 255}.${(addressCounter >> 8) & 255}.${addressCounter & 255}`;
};

export interface AnalyticsTestApp extends CatalogTestApp {
  sequelize: Sequelize;
  clickhouse: ClickHouseService;
  producer: KafkaProducerService;
  redis: Redis;
  /** The fault proxy in front of the app's Redis (only with `redisProxy: true`). */
  redisProxy: TcpFaultProxy | null;
  admin(): Promise<TestUser>;
  /** A valid client event with fresh ids, one second before the app clock. */
  event(patch?: Record<string, unknown>): Record<string, any>;
  /** `POST /api/events`, anonymous unless `user` is given. */
  postEvents(
    body: unknown,
    options?: PostOptions,
  ): ReturnType<ReturnType<CatalogTestApp['http']>['post']>;
  /** Everything on the topic, from the beginning. */
  topic(): Promise<LogMessage[]>;
  /** Parsed JSON lines of the structured logger (only with `structuredLogger: true`). */
  logs(): Array<Record<string, any>>;
}

/**
 * The real analytics modules (ingest, assignments, admin, results) behind the production HTTP pipeline, with real Postgres,
 * Redis, ClickHouse and Kafka. Faked at the edges only: the clock (frozen at `T0`, movable) and the token verifier (real
 * sessions). A spec that breaks a dependency spies on the dependency's client and restores it in `afterEach` (L-013).
 */
export async function createAnalyticsApp(
  options: {
    env?: Record<string, string>;
    structuredLogger?: boolean;
    extraImports?: unknown[];
    /** Runs the app's Redis connection through a fault proxy (`t.redisProxy.mode = 'refuse'`); restore it in `afterEach`. */
    redisProxy?: boolean;
  } = {},
): Promise<AnalyticsTestApp> {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
      })
    : null;
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const base = await createCatalogApp({
    extraImports: [AnalyticsModule, ...(options.extraImports ?? [])],
    env: { TRUSTED_PROXIES: '127.0.0.1', ...options.env },
    structuredLogger: options.structuredLogger,
    ...(redisProxy && { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` }),
  });
  base.clock.set(T0);
  const app = base.app;
  let counter = 0;
  const t: AnalyticsTestApp = {
    ...base,
    logs: () =>
      logChunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, any>),
    sequelize: app.get<Sequelize>(getConnectionToken()),
    clickhouse: app.get(ClickHouseService),
    producer: app.get(KafkaProducerService),
    redis: app.get(RedisService).client,
    redisProxy,
    close: async () => {
      stdoutSpy?.mockRestore();
      if (redisProxy) redisProxy.mode = 'pass';
      await base.close();
      await redisProxy?.close();
    },
    admin: () => base.newUser({ role: Role.ADMIN }),
    event(patch = {}) {
      return {
        event_id: uuidv4(),
        name: 'page_view',
        anonymous_id: `anon-${++counter}-${uuidv4().slice(0, 8)}`,
        ts: base.clock.nowMs() - 1_000,
        ...patch,
      };
    },
    postEvents(body, post = {}) {
      let request = base
        .http()
        .post('/api/events')
        .set('X-Forwarded-For', post.ip ?? nextAddress());
      if (post.user) request = request.set('Authorization', post.user.bearer);
      for (const [name, value] of Object.entries(post.headers ?? {}))
        request = request.set(name, value);
      request = request.set(
        'Content-Type',
        post.contentType ?? 'application/json',
      );
      return request.send(post.raw ?? JSON.stringify(body));
    },
    topic: () => readTopic(ANALYTICS_TOPIC),
  };
  return t;
}

export interface SeededExperiment {
  key: string;
  status: 'DRAFT' | 'RUNNING' | 'STOPPED';
  unit: 'user' | 'visitor';
  variants: { key: string; weight: number }[];
  layer: string;
  layerFrom: number;
  layerTo: number;
  metric: string;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

/**
 * Writes an experiment row straight into the table (what an admin's saves and start would have left), with a layer of its
 * own unless one is given, so specs never share a hash space (L-005).
 */
export async function seedExperiment(
  sequelize: Sequelize,
  patch: Partial<SeededExperiment> = {},
): Promise<SeededExperiment> {
  const id = uuidv4().slice(0, 8);
  const experiment: SeededExperiment = {
    key: `exp-${id}`,
    status: 'RUNNING',
    unit: 'visitor',
    variants: [
      { key: 'control', weight: 5_000 },
      { key: 'treatment', weight: 5_000 },
    ],
    layer: `layer-${id}`,
    layerFrom: 0,
    layerTo: 10_000,
    metric: 'page_view',
    startedAt: null,
    stoppedAt: null,
    createdAt: new Date(),
    ...patch,
  };
  await sequelize.query(
    `INSERT INTO "Experiment" ("key","description","owner","unit","status","variants","layer","layerFrom","layerTo","metric","version","startedAt","stoppedAt","createdAt","updatedAt")
     VALUES ($1,'', 'growth', $2, $3, $4::jsonb, $5, $6, $7, $8, 1, $9, $10, $11, $11)`,
    {
      bind: [
        experiment.key,
        experiment.unit,
        experiment.status,
        JSON.stringify(experiment.variants),
        experiment.layer,
        experiment.layerFrom,
        experiment.layerTo,
        experiment.metric,
        experiment.startedAt,
        experiment.stoppedAt,
        experiment.createdAt,
      ],
      type: QueryTypes.INSERT,
    },
  );
  return experiment;
}

/** Empties the experiment tables (and nothing else), for a spec's `beforeEach`. */
export async function truncateExperiments(sequelize: Sequelize): Promise<void> {
  await sequelize.query(`DELETE FROM "ExperimentAudit"`, {
    type: QueryTypes.DELETE,
  });
  await sequelize.query(`DELETE FROM "Experiment"`, {
    type: QueryTypes.DELETE,
  });
}
