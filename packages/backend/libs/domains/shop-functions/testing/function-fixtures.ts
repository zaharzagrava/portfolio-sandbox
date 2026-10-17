import { Logger, type INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import {
  outboxRowsFor,
  type OutboxRowView,
} from '@app/common/testing/outbox-rows';
import { TransactionRunner } from '@app/infrastructure/context';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { TimeSource } from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { AuthApiModule } from '@app/domains/identity';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { JudgeRecoveryService } from '../application/judge-recovery.service';
import { DiscountEvaluationService } from '../application/discount-evaluation.service';
import { JUDGE_QUEUE } from '../application/events/judge-requested.event';
import { shopFunctionsMetrics } from '../application/shop-functions.metrics';
import { sourceHash } from '../domain/source-hash';
import {
  SHOP_FUNCTIONS_ENTITLEMENTS,
  type ShopFunctionsEntitlements,
} from '../domain/ports';
import { startRunnerServer, type RunnerServer } from '../runner/main';
import { RUNNER_SOCKET_PATH } from '../infra/runner.client';
import { FunctionJudgeModule } from '../function-judge.module';
import { ShopFunctionsModule } from '../shop-functions.module';

/** The frozen "now" of the S45 scenarios. */
export const T0 = new Date('2026-10-17T12:00:00.000Z');

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
  admin: TestUser;
}

// ---- seller sources -----------------------------------------------------------------------------------------------

/** AS-10: "3rd case off": 200 off per unit on lines of 3 or more. */
export const GOOD_SOURCE = `function run(input) { return { discounts: input.lines.filter(l => l.quantity >= 3).map(l => ({ lineIndex: input.lines.indexOf(l), type: 'fixedPerUnit', value: 200, message: '3rd case off' })) }; }`;
export const LOOP_SOURCE = 'function run() { while (true) {} }';
export const THROW_SOURCE = `function run() { throw new Error('boom'); }`;
export const ALLOCATE_SOURCE =
  'function run() { var a = []; while (true) a.push(new Array(1e7).fill(1)); }';
export const REQUIRE_SOURCE = `function run() { require('fs').readFileSync('/etc/passwd'); return { discounts: [] }; }`;
export const EMPTY_SOURCE = 'function run() { return { discounts: [] }; }';
export const INVALID_OUTPUT_SOURCE = `function run() { return { discounts: [{ lineIndex: 0, type: 'free money', value: 1, message: 'x' }] }; }`;
export const SYNTAX_SOURCE = 'function run( {';
export const percentSource = (percent: number) =>
  `function run(input) { return { discounts: [{ lineIndex: 0, type: 'percentage', value: ${percent}, message: '${percent}% off' }] }; }`;
export const fixedPerUnitSource = (value: number) =>
  `function run(input) { return { discounts: [{ lineIndex: 0, type: 'fixedPerUnit', value: ${value}, message: 'fixed' }] }; }`;
/** Busy-waits `ms` using only the pure language (a counter), as the runtime has no clock. */
export const busySource = (iterations: number) =>
  `function run() { var x = 0; for (var i = 0; i < ${iterations}; i++) x += i; return { discounts: [] }; }`;

// ---- test suites --------------------------------------------------------------------------------------------------

export const lineOf = (
  quantity: number,
  unitPriceMinor = 1200,
  category = 'cases',
  productId = 'p1',
) => ({ productId, category, quantity, unitPriceMinor });

export const caseOf = (
  name: string,
  quantity: number,
  discounts: Array<{
    lineIndex: number;
    type: 'percentage' | 'fixedPerUnit';
    value: number;
    message: string;
  }> = [],
) => ({
  name,
  input: { currency: 'EUR', lines: [lineOf(quantity)] },
  expected: { discounts },
});

/** A one-line cart of `shopId` as orders hands it over (AS-24). */
export const cartOf = (
  shopId: string,
  quantity = 3,
  unitPriceMinor = 1200,
) => ({
  currency: 'EUR',
  lines: [
    { productId: 'p1', shopId, category: 'cases', quantity, unitPriceMinor },
  ],
});

/** The suite of AS-01 / AS-10. */
export const thirdCaseSuite = () => [
  caseOf('3 cases', 3, [
    { lineIndex: 0, type: 'fixedPerUnit', value: 200, message: '3rd case off' },
  ]),
  caseOf('2 cases', 2),
];

// ---- doubles ------------------------------------------------------------------------------------------------------

/** The shop-functions entitlement as billing will answer it (S18 has no such key yet): granted per shop, can fail, records batches. */
export class EntitlementsDouble implements ShopFunctionsEntitlements {
  readonly granted = new Set<string>();
  failing = false;
  readonly batches: string[][] = [];
  hasCalls = 0;

  getMany(shopIds: string[]): Promise<Map<string, boolean>> {
    this.batches.push([...shopIds]);
    if (this.failing) return Promise.reject(new Error('billing unavailable'));
    return Promise.resolve(
      new Map(shopIds.map((id) => [id, this.granted.has(id)])),
    );
  }

  has(shopId: string): Promise<boolean> {
    this.hasCalls++;
    if (this.failing) return Promise.reject(new Error('billing unavailable'));
    return Promise.resolve(this.granted.has(shopId));
  }

  reset() {
    this.granted.clear();
    this.failing = false;
    this.batches.length = 0;
    this.hasCalls = 0;
  }
}

type Agent = ReturnType<typeof supertest>;

export interface FunctionsTestApp {
  app: INestApplication;
  clock: FakeClock;
  entitlements: EntitlementsDouble;
  queue: InMemoryTaskQueue;
  redis: RedisService['client'];
  runner: {
    stop(): Promise<void>;
    start(): Promise<void>;
    readonly up: boolean;
  };
  http(): Agent;
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    put(url: string): ReturnType<Agent['put']>;
    delete(url: string): ReturnType<Agent['delete']>;
  };
  newUser(): Promise<TestUser>;
  /** A fresh session at the clock's current time (an access token lasts 5 minutes of that clock). */
  reauth(user: TestUser): Promise<TestUser>;
  /** A real tenancy shop with an owner and an admin; entitled to `shopFunctions` unless `entitled: false`. */
  seedShop(options?: {
    entitled?: boolean;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  }): Promise<SeededShop>;
  member(shopId: string, role: ShopRole): Promise<TestUser>;
  route(shopId: string, path?: string): string;
  /** POST a function through the API; returns the response. */
  create(
    user: TestUser,
    shopId: string,
    body?: { name?: string; tests?: unknown },
  ): ReturnType<Agent['post']>;
  /** Creates a function and returns its id (expects 201). */
  newFunction(
    user: TestUser,
    shopId: string,
    name?: string,
    tests?: unknown,
  ): Promise<string>;
  submit(
    user: TestUser,
    shopId: string,
    functionId: string,
    source: string,
  ): ReturnType<Agent['post']>;
  /** Inserts an enabled function with an ACTIVE version straight into the store (the checkout specs do not wait on the judge). */
  seedActive(
    shopId: string,
    options: {
      name?: string;
      source: string;
      version?: number;
      tests?: unknown[];
      enabled?: boolean;
    },
  ): Promise<{ functionId: string; version: number }>;
  /** Moves the judge requests of the outbox onto the queue and delivers them through the real consumer. */
  judge(functionId?: string): Promise<void>;
  /**
   * Delivers one judge message through the real consumer. The message is queued synchronously, so two calls started
   * together are two concurrent deliveries.
   */
  deliver(body: unknown): Promise<void>;
  /** A version straight into the store, in any status (a `SUPERSEDED` one passed unless `passed: false`). */
  insertVersion(
    functionId: string,
    version: number,
    status: 'QUEUED' | 'TESTING' | 'REJECTED' | 'SUPERSEDED',
    options?: { source?: string; passed?: boolean },
  ): Promise<void>;
  /** A trigger that makes the outbox refuse judge requests; `false` removes it. */
  failOutbox(on: boolean): Promise<void>;
  /** Judge requests still in the outbox (pending). */
  pendingRequests(functionId: string): Promise<OutboxRowView[]>;
  evaluate: DiscountEvaluationService['evaluateDiscounts'];
  recovery: JudgeRecoveryService;
  pg<T extends object>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  keys(pattern: string): Promise<Array<{ key: string; ttlMs: number }>>;
  logs(): Array<{ level: string; line: Record<string, unknown> }>;
  metrics: typeof shopFunctionsMetrics.value;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createFunctionsApp(): Promise<FunctionsTestApp> {
  const clock = new FakeClock(T0);
  const entitlements = new EntitlementsDouble();
  const queue = new InMemoryTaskQueue();
  const socketDir = mkdtempSync(join(tmpdir(), 'shopfn-'));
  const socketPath = join(socketDir, 'runner.sock');

  const logLines: Array<{ level: string; line: Record<string, unknown> }> = [];
  const capture = (level: string) =>
    jest
      .spyOn(Logger.prototype, level as 'warn')
      .mockImplementation((message: unknown) => {
        if (typeof message !== 'string' || !message.startsWith('{')) {
          // not one of ours; an error is kept as plain text so a failing spec can show the cause
          if (level === 'error')
            logLines.push({ level, line: { message: String(message) } });
          return;
        }
        try {
          logLines.push({ level, line: JSON.parse(message) });
        } catch {
          // not one of ours
        }
      });
  const spies = [capture('warn'), capture('log'), capture('error')];

  const moduleRef = await generateTestingModule(
    [AuthApiModule, SeedsModule, ShopFunctionsModule, FunctionJudgeModule],
    {
      stores: ['redis'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(TimeSource)
          .useValue({ overrideMs: () => clock.nowMs() })
          .overrideProvider(TaskQueue)
          .useValue(queue)
          .overrideProvider(SHOP_FUNCTIONS_ENTITLEMENTS)
          .useValue(entitlements)
          .overrideProvider(RUNNER_SOCKET_PATH)
          .useValue(socketPath),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  (app.get(ApiConfigService) as unknown as MockApiConfigService).set(
    'trusted_proxies',
    '127.0.0.0/8,::1',
  );
  configureHttpApp(app, { useStructuredLogger: false, processHandlers: false });
  await app.listen(0, '127.0.0.1');

  let runnerServer: RunnerServer | null = await startRunnerServer(socketPath);
  const runner = {
    async stop() {
      await runnerServer?.close();
      runnerServer = null;
    },
    async start() {
      if (!runnerServer) runnerServer = await startRunnerServer(socketPath);
    },
    get up() {
      return runnerServer !== null;
    },
  };

  const seeds = app.get(SeedsService);
  const sequelize = app.get<Sequelize>(getConnectionToken(), { strict: false });
  const redis = app.get(RedisService).client;
  const config = app.get(ApiConfigService) as unknown as MockApiConfigService;
  const evaluation = app.get(DiscountEvaluationService, { strict: false });
  const http = () => supertest(app.getHttpServer());
  let counter = 0;

  const pg = <T extends object>(
    query: string,
    replacements?: Record<string, unknown>,
  ) =>
    sequelize.query(query, {
      type: QueryTypes.SELECT,
      replacements,
    }) as Promise<T[]>;

  const t: FunctionsTestApp = {
    app,
    clock,
    entitlements,
    queue,
    redis,
    runner,
    http,
    as: (user) => ({
      get: (url) => http().get(url).set('Authorization', user.bearer),
      post: (url) => http().post(url).set('Authorization', user.bearer),
      put: (url) => http().put(url).set('Authorization', user.bearer),
      delete: (url) => http().delete(url).set('Authorization', user.bearer),
    }),
    async newUser() {
      const user = await createUser(app, {
        email: `functions-${++counter}-${Date.now()}@example.com`,
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
        name: `Shop ${uuidv4().slice(0, 6)}`,
        status: opts.status,
      });
      const admin = await t.member(shop.id, 'ADMIN');
      if (opts.entitled !== false) entitlements.granted.add(shop.id);
      return { shopId: shop.id, owner, admin };
    },
    async member(shopId, role) {
      const user = await t.newUser();
      await addMember(app, shopId, user.id, role, 'invite');
      return user;
    },
    route: (shopId, path = '') => `/api/shops/${shopId}/functions${path}`,
    create: (user, shopId, body = {}) =>
      t
        .as(user)
        .post(t.route(shopId))
        .send({
          name: body.name ?? `fn-${uuidv4().slice(0, 8)}`,
          tests: body.tests ?? thirdCaseSuite(),
        }),
    async newFunction(user, shopId, name, tests) {
      const res = await t.create(user, shopId, { name, tests });
      if (res.status !== 201)
        throw new Error(
          `create answered ${res.status}: ${JSON.stringify(res.body)}`,
        );
      return res.body.id;
    },
    submit: (user, shopId, functionId, source) =>
      t
        .as(user)
        .post(t.route(shopId, `/${functionId}/versions`))
        .send({ source }),
    async seedActive(shopId, opts) {
      const version = opts.version ?? 1;
      const functionId = uuidv4();
      const owner = uuidv4();
      // one unit of work: the pointer foreign key is checked when it commits
      await app.get(TransactionRunner).run(async () => {
        const run = (sql: string, replacements: Record<string, unknown>) =>
          sequelize.query(sql, { replacements });
        await run(
          `INSERT INTO "ShopFunction" ("id", "shopId", "name", "enabled", "activeVersion") VALUES (:functionId, :shopId, :name, :enabled, :version)`,
          {
            functionId,
            shopId,
            name: opts.name ?? `active-${functionId.slice(0, 8)}`,
            enabled: opts.enabled ?? true,
            version,
          },
        );
        await run(
          `INSERT INTO "ShopFunctionVersion" ("functionId", "version", "source", "sourceHash", "status", "verdicts", "createdBy", "createdAt", "updatedAt", "judgedAt")
           VALUES (:functionId, :version, :source, :hash, 'ACTIVE', '[]', :owner, :now, :now, :now)`,
          {
            functionId,
            version,
            source: opts.source,
            hash: sourceHash(opts.source),
            owner,
            now: clock.now(),
          },
        );
        await run(
          `INSERT INTO "ShopFunctionVersionHistory" ("functionId", "version", "fromStatus", "toStatus", "actorId", "at") VALUES (:functionId, :version, NULL, 'ACTIVE', :owner, :now)`,
          { functionId, version, owner, now: clock.now() },
        );
        for (const test of (opts.tests ?? []) as Array<{
          name: string;
          input: unknown;
          expected: unknown;
        }>)
          await run(
            `INSERT INTO "ShopFunctionTestCase" ("functionId", "version", "name", "input", "expected") VALUES (:functionId, :version, :name, CAST(:input AS jsonb), CAST(:expected AS jsonb))`,
            {
              functionId,
              version,
              name: test.name,
              input: JSON.stringify(test.input),
              expected: JSON.stringify(test.expected),
            },
          );
      });
      await redis.del(`shopfn:active:${shopId}`);
      return { functionId, version };
    },
    async pendingRequests(functionId) {
      return (await outboxRowsFor(app, functionId)).filter(
        (row) =>
          row.kind === 'task' &&
          row.type === 'shop_functions.judge_requested' &&
          row.status === 'pending',
      );
    },
    deliver(body) {
      void queue.enqueue(JUDGE_QUEUE, body);
      return queue.drain(JUDGE_QUEUE);
    },
    async insertVersion(functionId, version, status, opts = {}) {
      const source = opts.source ?? GOOD_SOURCE;
      const verdicts =
        opts.passed === false || status === 'QUEUED' || status === 'TESTING'
          ? null
          : status === 'REJECTED'
            ? [{ case: '3 cases', verdict: 'timeout', ms: 1 }]
            : [{ case: '3 cases', verdict: 'pass', ms: 1 }];
      await sequelize.query(
        `INSERT INTO "ShopFunctionVersion" ("functionId", "version", "source", "sourceHash", "status", "verdicts", "createdBy", "createdAt", "updatedAt")
         VALUES (:functionId, :version, :source, :hash, :status, CAST(:verdicts AS jsonb), :owner, :now, :now)`,
        {
          replacements: {
            functionId,
            version,
            source,
            hash: sourceHash(source),
            status,
            verdicts: verdicts && JSON.stringify(verdicts),
            owner: uuidv4(),
            now: clock.now(),
          },
        },
      );
    },
    async failOutbox(on) {
      await sequelize.query(
        `DROP TRIGGER IF EXISTS s45_fail_judge_request ON "Outbox"; DROP FUNCTION IF EXISTS s45_fail_judge_request()`,
      );
      if (!on) return;
      await sequelize.query(`
        CREATE FUNCTION s45_fail_judge_request() RETURNS trigger AS $$
        BEGIN
          IF NEW."type" = 'shop_functions.judge_requested' THEN
            RAISE EXCEPTION 'outbox insert refused (injected)';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s45_fail_judge_request BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION s45_fail_judge_request();
      `);
    },
    async judge(functionId) {
      const rows = functionId
        ? await t.pendingRequests(functionId)
        : (
            await pg<{ id: string; aggregateId: string }>(
              `SELECT "id", "aggregateId" FROM "Outbox" WHERE "type" = 'shop_functions.judge_requested' AND "status" = 'pending' ORDER BY "id"`,
            )
          ).map((r) => ({ id: r.id }) as OutboxRowView);
      for (const row of rows) {
        const [full] = await pg<{ payload: { body: unknown } }>(
          `SELECT "payload" FROM "Outbox" WHERE "id" = :id`,
          { id: row.id },
        );
        await queue.enqueue(JUDGE_QUEUE, full.payload.body);
        await sequelize.query(
          `UPDATE "Outbox" SET "status" = 'published' WHERE "id" = :id`,
          {
            replacements: { id: row.id },
          },
        );
      }
      await queue.drain(JUDGE_QUEUE);
    },
    evaluate: (cart) => evaluation.evaluateDiscounts(cart),
    recovery: app.get(JudgeRecoveryService, { strict: false }),
    pg,
    async keys(pattern) {
      const out: Array<{ key: string; ttlMs: number }> = [];
      let cursor = '0';
      do {
        const [next, found] = await redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          500,
        );
        cursor = next;
        for (const key of found)
          out.push({ key, ttlMs: await redis.pttl(key) });
      } while (cursor !== '0');
      return out;
    },
    logs: () => [...logLines],
    metrics: shopFunctionsMetrics.value,
    async reset() {
      await t.runner.start();
      await t.failOutbox(false);
      clock.set(T0);
      entitlements.reset();
      queue.sent.length = 0;
      queue.deadLettered.length = 0;
      await seeds.clean();
      await sequelize.query(
        `DELETE FROM "ShopFunction"; DELETE FROM "Outbox" WHERE "type" = 'shop_functions.judge_requested';`,
      );
      for (const entry of await t.keys('shopfn:*')) await redis.del(entry.key);
      config.reset();
      logLines.length = 0;
    },
    async close() {
      for (const spy of spies) spy.mockRestore();
      await t.failOutbox(false).catch(() => undefined);
      await runner.stop();
      await app.close();
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
  return t;
}
