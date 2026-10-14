import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { Role } from '@app/domains/identity';
import { CLOCK } from '@app/common/core/clock';
import { TopicSubscriber } from '@app/infrastructure/realtime';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { FlagsClient } from '../application/flags-client.service';
import { RulesetRepairService } from '../application/ruleset-repair.service';
import { RulesetPublisherService } from '../application/ruleset-publisher.service';
import {
  EVAL_COUNTER_STORE,
  FLAG_REPOSITORY,
  RULESET_SOURCE,
} from '../domain/ports';
import type { FlagRepository } from '../domain/ports';
import { FlagTopicsModule } from '../realtime-topics.module';
import { FlagsAdminModule } from '../flags-admin.module';
import { FlagsSdkModule } from '../flags.module';
import { FlagsWorkerModule } from '../flags-worker.module';
import { RULESET_KEY } from '../infra/redis-keys';

/** A valid flag definition body (`expectedVersion: 0`, a 5 % rollout, disabled) with the given changes. */
export function flagBody(patch: Record<string, unknown> = {}) {
  return {
    expectedVersion: 0,
    description: 'a test flag',
    owner: 'checkout-team',
    enabled: false,
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    defaultVariant: 'off',
    offVariant: 'off',
    bucketBy: 'userId',
    clientSide: false,
    rules: [
      {
        id: 'rollout',
        conditions: [],
        rollout: [
          { variant: 'on', weight: 500 },
          { variant: 'off', weight: 9_500 },
        ],
      },
    ],
    ...patch,
  };
}

/** A rollout of `percent` per cent to `on`, the rest `off`. */
export const rolloutRules = (percent: number) => [
  {
    id: 'rollout',
    conditions: [],
    rollout: [
      { variant: 'on', weight: percent * 100 },
      { variant: 'off', weight: 10_000 - percent * 100 },
    ],
  },
];

export interface FlagsTestApp extends CatalogTestApp {
  sdk: FlagsClient;
  repository: FlagRepository;
  repair: RulesetRepairService;
  publishing: RulesetPublisherService;
  sequelize: Sequelize;
  redis: Redis;
  /** Parsed JSON lines of the structured logger (only with `structuredLogger: true`). */
  logs(): Array<Record<string, any>>;
  admin(): Promise<TestUser>;
  /** `PUT /api/admin/flags/:key` as `user`. */
  put(
    user: TestUser,
    key: string,
    body: Record<string, unknown>,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['put']>;
  /** Creates a flag through the API (throws unless 201) and returns its stored view. */
  create(
    user: TestUser,
    key: string,
    patch?: Record<string, unknown>,
  ): Promise<Record<string, any>>;
  post(
    user: TestUser,
    path: string,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** A key no other test uses. */
  key(prefix?: string): string;
  flagRows(): Promise<Array<Record<string, any>>>;
  flagRow(key: string): Promise<Record<string, any> | undefined>;
  auditRows(key: string): Promise<Array<Record<string, any>>>;
  outboxRows(key?: string): Promise<Array<Record<string, any>>>;
  rulesetVersion(): Promise<number>;
  cachedSnapshot(): Promise<{
    version: number;
    flags: Array<Record<string, any>>;
  } | null>;
  /** Rewrites the ruleset cache entry as another process would have left it. */
  setCache(value: unknown): Promise<void>;
  /** Waits until the SDK of this app holds at least `version`. */
  untilVersion(version: number): Promise<void>;
  /**
   * A new SDK instance (a "process") over the real stores, started like the app's own. Destroyed by `disposeSdks()`
   * (call it in `afterEach`) so a spec that feeds it odd snapshots cannot leak into the next one.
   */
  freshSdk(): Promise<FlagsClient>;
  disposeSdks(): Promise<void>;
  /** Moves the stored creation time of a flag (the stale report reads it). */
  backdate(key: string, createdAt: Date): Promise<void>;
}

/**
 * The real flags modules (SDK, admin routes and client endpoint, repair job) behind the production HTTP pipeline, with
 * real Postgres and Redis. Faked at the edges only: the clock (movable) and the token verifier (real sessions). A spec
 * that breaks a store spies on the store's client and restores it in `afterEach` (L-013). Every spec creates its own flags (L-005, L-006).
 */
export async function createFlagsApp(
  options: {
    env?: Record<string, string>;
    structuredLogger?: boolean;
    /** Further modules (a spec's own controller behind `@RequireFlag`). */
    extraImports?: unknown[];
  } = {},
): Promise<FlagsTestApp> {
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
    extraImports: [
      FlagsSdkModule,
      FlagsAdminModule,
      FlagsWorkerModule,
      FlagTopicsModule,
      ...(options.extraImports ?? []),
    ],
    env: options.env,
    structuredLogger: options.structuredLogger,
  });
  const app = base.app;
  const sequelize = app.get<Sequelize>(getConnectionToken());
  const redis = app.get(RedisService).client;
  const sdk = app.get(FlagsClient);
  const repository = app.get<FlagRepository>(FLAG_REPOSITORY);
  let counter = 0;
  const fresh: FlagsClient[] = [];

  const rows = async (sql: string, bind: unknown[] = []) =>
    sequelize.query<Record<string, any>>(sql, {
      bind,
      type: QueryTypes.SELECT,
    });

  const t: FlagsTestApp = {
    ...base,
    sdk,
    repository,
    repair: app.get(RulesetRepairService),
    publishing: app.get(RulesetPublisherService),
    sequelize,
    redis,
    logs: () =>
      logChunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, any>),
    close: async () => {
      await t.disposeSdks();
      stdoutSpy?.mockRestore();
      await base.close();
    },
    async freshSdk() {
      const client = new FlagsClient(
        app.get(RULESET_SOURCE),
        app.get(EVAL_COUNTER_STORE),
        app.get(TopicSubscriber),
        app.get(CLOCK),
      );
      await client.onModuleInit();
      fresh.push(client);
      return client;
    },
    async disposeSdks() {
      await Promise.all(fresh.splice(0).map((c) => c.onModuleDestroy()));
    },
    admin: () => base.newUser({ role: Role.ADMIN }),
    put: (user, key, body) =>
      base.as(user).put(`/api/admin/flags/${key}`).send(body),
    async create(user, key, patch = {}) {
      const res = await t.put(user, key, flagBody(patch));
      if (res.status !== 201)
        throw new Error(
          `create ${key} answered ${res.status}: ${JSON.stringify(res.body)}`,
        );
      return res.body;
    },
    post: (user, path) => base.as(user).post(path),
    key: (prefix = 'flag') => `${prefix}-${++counter}-${uuidv4().slice(0, 8)}`,
    flagRows: () => rows(`SELECT * FROM "FeatureFlag" ORDER BY "key"`),
    flagRow: async (key) =>
      (await rows(`SELECT * FROM "FeatureFlag" WHERE "key" = $1`, [key]))[0],
    auditRows: (key) =>
      rows(
        `SELECT * FROM "FlagAudit" WHERE "flagKey" = $1 ORDER BY "at" DESC, "id" DESC`,
        [key],
      ),
    outboxRows: (key) =>
      key
        ? rows(
            `SELECT * FROM "Outbox" WHERE "type" = 'experimentation.flag_changed' AND "aggregateId" = $1 ORDER BY "createdAt"`,
            [key],
          )
        : rows(
            `SELECT * FROM "Outbox" WHERE "type" = 'experimentation.flag_changed' ORDER BY "createdAt"`,
          ),
    rulesetVersion: () => repository.rulesetVersion(),
    async cachedSnapshot() {
      const raw = await redis.get(RULESET_KEY);
      return raw ? JSON.parse(raw) : null;
    },
    async setCache(value) {
      await redis.set(
        RULESET_KEY,
        typeof value === 'string' ? value : JSON.stringify(value),
        'EX',
        3600,
      );
    },
    async untilVersion(version) {
      const deadline = Date.now() + 5_000;
      while (sdk.version < version) {
        if (Date.now() > deadline)
          throw new Error(
            `SDK stayed at v${sdk.version}, expected v${version}`,
          );
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async backdate(key, createdAt) {
      await sequelize.query(
        `UPDATE "FeatureFlag" SET "createdAt" = $2 WHERE "key" = $1`,
        { bind: [key, createdAt], type: QueryTypes.UPDATE },
      );
    },
  };
  return t;
}
