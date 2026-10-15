import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  definePolicies,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import {
  createLimiter,
  proxyUrl,
  startStoreProxy,
  T0,
} from '@app/infrastructure/rate-limit/test/limiter-fixture';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { waitFor } from '@app/test/utils/async-helpers';
import { ManualTimeSource } from '@app/infrastructure/rate-limit/time-source';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { IntegrationHealthService } from './application/integration-health.service';
import { ReconcileService } from './application/reconcile.service';
import { LinkApplyService } from './application/link-apply.service';
import { StockSyncService } from './application/stock-sync.service';
import { SyncEngineService } from './application/sync-engine.service';
import { parseCredentials, serialiseCredentials } from './domain/credentials';
import { BREAKER_FAILURES, BREAKER_OPEN_MS } from './domain/breaker';
import {
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_REPOSITORY,
  PROVIDER_SESSIONS,
  ProviderCallError,
  RUN_REPOSITORY,
  SHOP_STATUS_GATEWAY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRepository,
  type ProviderSessions,
  type SyncMessage,
} from './domain/ports';
import { IntegrationsJobs } from './infra/integrations.jobs';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { HttpProviderSessions } from './infra/provider-sessions.adapter';
import { SyncConsumer } from './infra/queue/sync.consumer';
import type { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

const stores = new Map<string, string>();
const resolver = createStubResolver();
const noSleep = async () => undefined;
/** Mutable seams of the shared provider network: each test sets what it needs, `beforeEach` resets them. */
const network: ProviderNetwork & { timeoutMs?: number } = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: noSleep,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

const bucket5 = definePolicies('catalog-sync', {
  // Burst 5, refill 1 per second: never more than 5 calls in any half-open second.
  'integrations.shopify': {
    algorithm: 'tokenBucket',
    limit: 5,
    windowMs: 5_000,
    key: 'apiKey',
    failMode: 'closed',
  },
} as const);

describe('Integration provider resilience', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let config: ApiConfigService;
  let engine: SyncEngineService;
  let integrations: IntegrationRepository;
  let cursors: CursorRepository;
  let vault: CredentialVault;
  let sessions: ProviderSessions;
  let jobs: IntegrationsJobs;
  let consumer: SyncConsumer;
  let enqueue: jest.SpyInstance;
  let redis: RedisService;
  let outbox: OutboxService;
  let worker: ReturnType<CatalogTestApp['app']['select']>;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    config = ctx.app.get(ApiConfigService);
    redis = ctx.app.get(RedisService);
    outbox = ctx.app.get(OutboxService);
    worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    cursors = worker.get(CURSOR_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    sessions = worker.get(PROVIDER_SESSIONS);
    jobs = worker.get(IntegrationsJobs);
    consumer = worker.get(SyncConsumer);
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    enqueue.mockClear();
    resolver.reset();
    stores.clear();
    network.sleep = noSleep;
    network.timeoutMs = undefined;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const f of fakes.splice(0)) await f.stop();
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'IntegrationHistory',
      ])
        await db.query(
          `DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`,
          { replacements },
        );
      await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
        replacements,
      });
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements,
      });
      integrationIds.length = 0;
    }
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world(
    options: { refreshToken?: string; pageSize?: number } = {},
  ) {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const domain = `res-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: options.pageSize ?? 2,
      clientId: String(config.get('shopify_app_key')),
      clientSecret: String(config.get('shopify_app_secret')),
    });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const id = randomUUID();
    const result = await integrations.insertConnected({
      id,
      shopId: shop.id,
      provider: 'shopify',
      externalShop: domain,
      credentialsSealed: vault.seal(
        id,
        serialiseCredentials({
          provider: 'shopify',
          accessToken: fake.accessToken,
          scope: SCOPES,
          ...(options.refreshToken
            ? { refreshToken: options.refreshToken }
            : {}),
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(result.kind).toBe('inserted');
    integrationIds.push(id);
    return { shopId: shop.id, owner, fake, id, domain };
  }

  const incrementalMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'incremental',
  });
  const oneMsg = (integrationId: string, externalId: string): SyncMessage => ({
    integrationId,
    kind: 'one',
    externalId,
  });

  const runs = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncRun" WHERE "integrationId" = :integrationId ORDER BY "id"`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );
  const rowOf = async (id: string) => (await integrations.findById(id))!;
  const events = (integrationId: string, type: string) =>
    db.query<Record<string, any>>(
      `SELECT payload FROM "Outbox" WHERE "aggregateId" = :integrationId AND "type" = :type`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId, type },
      },
    );
  const attention = async (integrationId: string) =>
    (
      await events(integrationId, 'catalogsync.integration_attention_required')
    ).map((e) => e.payload.payload);
  const history = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationHistory" WHERE "integrationId" = :integrationId ORDER BY "at"`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );
  const listRequests = (fake: FakeShopify) =>
    fake.requestsTo('GET', /\/products\.json$/);
  const isList = (r: { method: string; path: string }) =>
    r.method === 'GET' && r.path.endsWith('/products.json');
  const counter = (name: string, labels: Record<string, string | number>) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const messagesTo = (integrationId: string) =>
    enqueue.mock.calls.filter(
      ([, body]) => body.integrationId === integrationId,
    );

  async function failureOf(
    promise: Promise<unknown>,
  ): Promise<ProviderCallError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCallError);
      return error as ProviderCallError;
    }
    throw new Error('expected the call to fail');
  }

  // ---- AS-54 ---------------------------------------------------------------------------------------------------

  describe('AS-54 response validation', () => {
    it.each([
      [
        'products is not an array',
        { kind: 'status', status: 200, json: { products: 'nope' } },
      ],
      [
        'an HTML error page with status 200',
        { kind: 'garbage', body: '<html><body>Bad gateway</body></html>' },
      ],
      [
        'a JSON body of the wrong type',
        { kind: 'status', status: 200, json: [1, 2, 3] },
      ],
    ] as const)(
      'S08 AS-54: %s fails the run provider_schema_invalid, stores nothing and counts one breaker failure',
      async (_name, fault) => {
        const t = await world({ pageSize: 10 });
        t.fake.addProduct({ title: 'Never stored', stock: 1 });
        t.fake.inject({ match: isList, fault: fault as never });

        const outcome = await engine.handle(incrementalMsg(t.id));

        expect(outcome).toBe('failed');
        expect((await runs(t.id))[0]).toMatchObject({
          outcome: 'failed',
          detail: 'schema_invalid',
        });
        expect((await rowOf(t.id)).lastError).toBe('provider_schema_invalid');
        const [{ n: links }] = await db.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM "ExternalLink" WHERE "integrationId" = :id) + (SELECT count(*) FROM "SyncQuarantine" WHERE "integrationId" = :id) AS n`,
          { type: QueryTypes.SELECT, replacements: { id: t.id } },
        );
        expect(Number(links)).toBe(0);
        expect(listRequests(t.fake)).toHaveLength(1);
        expect((await integrations.loadBreaker(t.id))!.failures).toBe(1);
      },
    );

    it.each([
      [
        'another host',
        (origin: string, evil: string, api: string) =>
          `${evil}${api}/products.json?page_info=x`,
      ],
      [
        'another scheme',
        (origin: string, _evil: string, api: string) =>
          `${origin.replace('http:', 'https:')}${api}/products.json?page_info=x`,
      ],
      [
        'a path outside the store API',
        (origin: string, _evil: string, _api: string) =>
          `${origin}/evil/products.json?page_info=x`,
      ],
    ])(
      'S08 AS-54: a Link next to %s is not followed and the run fails provider_schema_invalid',
      async (_name, target) => {
        const t = await world({ pageSize: 10 });
        const evil = new FakeShopify({ shopDomain: 'evil.myshopify.com' });
        await evil.start();
        fakes.push(evil);
        t.fake.inject({
          match: isList,
          fault: {
            kind: 'status',
            status: 200,
            json: { products: [] },
            headers: {
              link: `<${target(t.fake.baseUrl, evil.baseUrl, `/admin/api/${t.fake.apiVersion}`)}>; rel="next"`,
            },
          },
        });

        expect(await engine.handle(incrementalMsg(t.id))).toBe('failed');

        expect((await runs(t.id))[0].detail).toBe('schema_invalid');
        expect(listRequests(t.fake)).toHaveLength(1);
        expect(evil.requests).toHaveLength(0);
        expect(
          t.fake.requests.filter((r) => r.path.startsWith('/evil')),
        ).toHaveLength(0);
      },
    );
  });

  // ---- AS-55 ---------------------------------------------------------------------------------------------------

  describe('AS-55 shared rate budget', () => {
    const read = {
      method: 'GET',
      path: '/shop.json',
      idempotent: true,
    } as const;

    function workerSessions(limiter: RateLimiterService, net: ProviderNetwork) {
      return new HttpProviderSessions(
        config,
        limiter,
        integrations,
        vault,
        ctx.clock,
        outbox,
        redis,
        net,
      );
    }

    function engineFor(s: ProviderSessions) {
      return new SyncEngineService(
        config,
        worker.get(LinkApplyService),
        worker.get(StockSyncService),
        integrations,
        cursors,
        worker.get(RUN_REPOSITORY),
        s,
        worker.get(SHOP_STATUS_GATEWAY),
        worker.get(SYNC_QUEUE),
        worker.get(SYNC_CLOCK),
        worker.get(TransactionRunner),
        outbox,
        worker.get(IntegrationHealthService),
        worker.get(ReconcileService),
      );
    }

    it('S08 AS-55: two worker instances making 12 calls on a 5-call bucket never exceed 5 calls in any second, get no 429, and another credential is not slowed', async () => {
      const a = await world();
      const b = await world();
      const time = new ManualTimeSource(T0);
      const waits: number[] = [];
      const net: ProviderNetwork = {
        ...network,
        sleep: async (ms) => {
          waits.push(ms);
          time.advance(ms);
          ctx.clock.advance(ms);
          await tick();
        },
      };
      const one = await createLimiter({
        policies: [bucket5],
        probe: false,
        time,
      });
      const two = await createLimiter({
        policies: [bucket5],
        probe: false,
        time,
      });
      cleanups.push(
        () => one.close(),
        () => two.close(),
      );
      // The virtual time of every admission the shared bucket granted for credential A (read where the decision is made).
      const stamps: number[] = [];
      const recording = (real: RateLimiterService) =>
        ({
          check: async (
            policy: 'integrations.shopify',
            subject: string,
            cost?: number,
          ) => {
            const at = time.overrideMs()!;
            const decision = await real.check(policy, subject, cost);
            if (decision.allowed && subject === a.id) stamps.push(at);
            return decision;
          },
          penalize: real.penalize.bind(real),
        }) as unknown as RateLimiterService;
      const s1 = workerSessions(recording(one.limiter), net).forIntegration(
        await rowOf(a.id),
      );
      const s2 = workerSessions(recording(two.limiter), net).forIntegration(
        await rowOf(a.id),
      );

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? s1 : s2).call.call(read)),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(a.fake.requestsTo('GET', /\/shop\.json$/)).toHaveLength(12);
      expect(stamps).toHaveLength(12);
      for (const start of stamps)
        expect(
          stamps.filter((s) => s >= start && s < start + 1_000).length,
        ).toBeLessThanOrEqual(5);
      expect(a.fake.requests.filter((r) => r.status === 429)).toHaveLength(0);
      expect(waits.length).toBeGreaterThan(0);

      // Another credential has its own bucket: it is served at once, without any wait.
      const before = waits.length;
      const other = workerSessions(one.limiter, net).forIntegration(
        await rowOf(b.id),
      );
      expect((await other.call.call(read)).status).toBe(200);
      expect(waits.length).toBe(before);
    }, 30_000);

    it('S08 AS-55: with the limiter store down the run ends yielded rate_limiter_unavailable, queues a continuation and the provider receives no call', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Untouched', stock: 1 });
      const proxy: TcpFaultProxy = await startStoreProxy();
      const inst = await createLimiter({
        policies: [bucket5],
        probe: false,
        clientUrl: proxyUrl(proxy),
      });
      cleanups.push(async () => {
        proxy.mode = 'pass';
        await inst.close();
        await proxy.close();
      });
      const downEngine = engineFor(workerSessions(inst.limiter, network));
      proxy.mode = 'refuse';
      proxy.sever();
      await waitFor(async () => inst.redis.client.status !== 'ready', {
        timeoutMs: 5_000,
        intervalMs: 10,
      });

      const outcome = await downEngine.handle(incrementalMsg(t.id));

      expect(outcome).toBe('yielded');
      expect((await runs(t.id))[0]).toMatchObject({
        outcome: 'yielded',
        detail: 'rate_limiter_unavailable',
      });
      expect(t.fake.requests).toHaveLength(0);
      expect(messagesTo(t.id)).toHaveLength(1);
    }, 30_000);
  });

  // ---- AS-56 ---------------------------------------------------------------------------------------------------

  describe('AS-56 Retry-After', () => {
    it('S08 AS-56: a 429 with Retry-After 3 pauses the credential bucket for every worker, makes no other call meanwhile and retries once after at least 3 seconds', async () => {
      const t = await world({ pageSize: 10 });
      t.fake.addProduct({ title: 'Mug', stock: 1 });
      t.fake.inject({
        match: isList,
        fault: { kind: 'rate_limit', retryAfterSeconds: 3 },
        times: 1,
      });
      const limiter = ctx.app.get(RateLimiterService);
      let pausedSeenByOtherWorker:
        Awaited<ReturnType<RateLimiterService['check']>> | undefined;
      let requestsDuringWait = -1;
      const before429 = counter('catalog_sync_provider_429_total', {
        provider: 'shopify',
      });
      network.sleep = async (ms) => {
        if (ms >= 3_000) {
          pausedSeenByOtherWorker = await limiter.check(
            'integrations.shopify',
            t.id,
          );
          requestsDuringWait = t.fake.requests.length;
        }
        await new Promise((r) => setTimeout(r, ms));
      };

      const outcome = await engine.handle(incrementalMsg(t.id));

      expect(outcome).toBe('completed');
      expect(pausedSeenByOtherWorker).toMatchObject({
        allowed: false,
        reason: 'paused',
      });
      expect(pausedSeenByOtherWorker!.retryAfterMs).toBeGreaterThan(2_000);
      // While the bucket was paused the only call the provider had seen was the refused one; the retry came after it.
      expect(requestsDuringWait).toBe(1);
      expect(t.fake.requests.slice(0, 2).map((r) => r.status)).toEqual([
        429, 200,
      ]);
      const asked = listRequests(t.fake);
      expect(asked).toHaveLength(2);
      expect(asked[1].at - asked[0].at).toBeGreaterThanOrEqual(2_900);
      expect(
        counter('catalog_sync_provider_429_total', { provider: 'shopify' }),
      ).toBe(before429 + 1);
    }, 30_000);

    it.each([
      [120, 120],
      [3_600, 900],
    ])(
      'S08 AS-56: Retry-After %i s yields the run, queues a continuation delayed %i s (capped at 15 minutes) and retries nothing inline',
      async (header, delay) => {
        const t = await world({ pageSize: 10 });
        t.fake.addProduct({ title: 'Mug', stock: 1 });
        t.fake.inject({
          match: isList,
          fault: { kind: 'rate_limit', retryAfterSeconds: header },
          times: 1,
        });

        const outcome = await engine.handle(incrementalMsg(t.id));

        expect(outcome).toBe('yielded');
        expect(listRequests(t.fake)).toHaveLength(1);
        expect((await runs(t.id))[0]).toMatchObject({
          outcome: 'yielded',
          detail: 'rate_limited',
        });
        const sent = messagesTo(t.id);
        expect(sent).toHaveLength(1);
        expect(sent[0][1]).toMatchObject({
          integrationId: t.id,
          kind: 'incremental',
        });
        expect(sent[0][2]).toEqual({ delaySeconds: delay });
      },
    );
  });

  // ---- AS-57 ---------------------------------------------------------------------------------------------------

  describe('AS-57 retry policy', () => {
    it('S08 AS-57: 503, 503, 200 succeeds on attempt 3 with two full-jitter waits below the 8 s cap', async () => {
      const t = await world({ pageSize: 10 });
      t.fake.addProduct({ title: 'Mug', stock: 1 });
      t.fake.inject({
        match: isList,
        fault: { kind: 'status', status: 503 },
        times: 2,
      });
      const waits: number[] = [];
      network.sleep = async (ms) => void waits.push(ms);

      expect(await engine.handle(incrementalMsg(t.id))).toBe('completed');

      expect(listRequests(t.fake)).toHaveLength(3);
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeLessThanOrEqual(500);
      expect(waits[1]).toBeLessThanOrEqual(1_000);
      expect((await integrations.loadBreaker(t.id))!.failures).toBe(0);
    });

    it.each([400, 403, 404, 422])(
      'S08 AS-57: a %i answer is not retried',
      async (status) => {
        const t = await world({ pageSize: 10 });
        t.fake.inject({
          match: isList,
          fault: { kind: 'status', status, json: { errors: 'no' } },
        });

        expect(await engine.handle(incrementalMsg(t.id))).toBe('failed');

        expect(listRequests(t.fake)).toHaveLength(1);
        // The provider answered on purpose: it is up, the breaker does not count it.
        expect((await integrations.loadBreaker(t.id))!.failures).toBe(0);
      },
    );

    it('S08 AS-57: 503 on every attempt stops after exactly 3 attempts, fails the run and counts ONE breaker failure', async () => {
      const t = await world({ pageSize: 10 });
      t.fake.inject({ match: isList, fault: { kind: 'status', status: 503 } });

      expect(await engine.handle(incrementalMsg(t.id))).toBe('failed');

      expect(listRequests(t.fake)).toHaveLength(3);
      expect((await runs(t.id))[0]).toMatchObject({
        outcome: 'failed',
        detail: 'unavailable',
      });
      expect((await integrations.loadBreaker(t.id))!.failures).toBe(1);
    });

    it('S08 AS-57: the conditional stock write is retried after a timeout and lands once; webhook registration that times out is not retried', async () => {
      const t = await world({ pageSize: 10 });
      const product = t.fake.addProduct({ title: 'Mug', stock: 4 });
      const variant = product.variants[0];
      network.timeoutMs = 250;
      const session = sessions.forIntegration(await rowOf(t.id));
      const provider = sessions.provider('shopify');
      const stockPath = (r: { method: string; path: string }) =>
        r.method === 'POST' && r.path.endsWith('/inventory_levels/set.json');

      t.fake.inject({
        match: stockPath,
        fault: { kind: 'delay', ms: 700 },
        times: 1,
      });
      const outcome = await provider.setStock(
        session,
        `${product.id}:${variant.id}`,
        9,
        4,
      );
      expect(outcome).toBe('accepted');
      expect(t.fake.stockWrites.length).toBeGreaterThanOrEqual(2);
      expect(t.fake.stockOf(variant.id)).toBe(9);

      t.fake.clearFaults();
      t.fake.clearLog();
      t.fake.inject({
        match: (r) => r.method === 'POST' && r.path.endsWith('/webhooks.json'),
        fault: { kind: 'delay', ms: 700 },
      });
      const error = await failureOf(
        provider.registerWebhooks(session, {
          callbackUrl: 'https://example.com/hooks',
        }),
      );
      expect(error.kind).toBe('timeout');
      expect(t.fake.requestsTo('POST', /\/webhooks\.json$/)).toHaveLength(1);
    }, 30_000);
  });

  // ---- AS-58 ---------------------------------------------------------------------------------------------------

  it('S08 AS-58: a provider that never answers is aborted at the timeout, retried, counted as one failure, the run ends failed, the message goes back to the queue and the lease is released', async () => {
    const t = await world({ pageSize: 10 });
    network.timeoutMs = 200;
    t.fake.inject({ match: isList, fault: { kind: 'delay', ms: 600 } });

    await expect(
      consumer.handle({ body: incrementalMsg(t.id) }),
    ).rejects.toThrow();

    expect(listRequests(t.fake)).toHaveLength(3);
    expect((await runs(t.id))[0]).toMatchObject({
      outcome: 'failed',
      detail: 'timeout',
    });
    expect((await integrations.loadBreaker(t.id))!.failures).toBe(1);
    const cursor = await cursors.read(t.id, 'product');
    expect(cursor?.leaseHolder ?? null).toBeNull();
    expect((await rowOf(t.id)).lastError).toBe('provider_timeout');
  }, 30_000);

  // ---- AS-59 ---------------------------------------------------------------------------------------------------

  describe('AS-59 circuit breaker', () => {
    async function openBreaker() {
      const t = await world({ pageSize: 10 });
      t.fake.inject({ match: isList, fault: { kind: 'status', status: 503 } });
      for (let i = 0; i < BREAKER_FAILURES; i++)
        expect(await engine.handle(incrementalMsg(t.id))).toBe('failed');
      return t;
    }
    const read = {
      method: 'GET',
      path: '/shop.json',
      idempotent: true,
    } as const;

    it('S08 AS-59: five failed calls open the breaker for 5 minutes, runs end skipped_breaker_open without a provider call, the scheduler skips it and one attention event is written', async () => {
      const t = await openBreaker();
      const opened = await integrations.loadBreaker(t.id);
      expect(opened!.failures).toBe(BREAKER_FAILURES);
      expect(opened!.openUntil!.getTime()).toBe(
        ctx.clock.now().getTime() + BREAKER_OPEN_MS,
      );
      expect((await rowOf(t.id)).status).toBe('ACTIVE');
      expect(await attention(t.id)).toEqual([
        expect.objectContaining({
          reason: 'breaker_open',
          integrationId: t.id,
        }),
      ]);

      const requests = t.fake.requests.length;
      expect(await engine.handle(incrementalMsg(t.id))).toBe(
        'skipped_breaker_open',
      );
      expect(t.fake.requests.length).toBe(requests);
      expect((await runs(t.id)).at(-1)).toMatchObject({
        outcome: 'skipped_breaker_open',
      });

      await integrations.setNextSync(
        t.id,
        new Date(ctx.clock.now().getTime() - 1_000),
      );
      await jobs.syncAll();
      expect(messagesTo(t.id)).toHaveLength(0);
      expect(await attention(t.id)).toHaveLength(1);
    });

    it('S08 AS-59: after 5 minutes exactly one probe call is made even with two callers; its success closes the breaker', async () => {
      const t = await openBreaker();
      t.fake.clearFaults();
      ctx.clock.advance(BREAKER_OPEN_MS + 1_000);
      const gate = t.fake.gate((r) => r.path.endsWith('/shop.json'), {
        once: true,
      });
      t.fake.clearLog();
      const session = sessions.forIntegration(await rowOf(t.id));

      const probe = session.call.call(read);
      await gate.reached;
      const second = await failureOf(session.call.call(read));
      expect(second.kind).toBe('breaker_open');
      gate.release();

      expect((await probe).status).toBe(200);
      expect(t.fake.requestsTo('GET', /\/shop\.json$/)).toHaveLength(1);
      expect(await integrations.loadBreaker(t.id)).toMatchObject({
        failures: 0,
        openUntil: null,
      });
      expect((await session.call.call(read)).status).toBe(200);
    });

    it('S08 AS-59: a failed probe reopens the breaker for another 5 minutes without a second attention event', async () => {
      const t = await openBreaker();
      t.fake.clearFaults();
      t.fake.inject({ fault: { kind: 'status', status: 503 } });
      ctx.clock.advance(BREAKER_OPEN_MS + 1_000);
      const session = sessions.forIntegration(await rowOf(t.id));

      expect((await failureOf(session.call.call(read))).kind).toBe(
        'unavailable',
      );

      const state = await integrations.loadBreaker(t.id);
      expect(state!.openUntil!.getTime()).toBeGreaterThan(
        ctx.clock.now().getTime(),
      );
      expect((await failureOf(session.call.call(read))).kind).toBe(
        'breaker_open',
      );
      expect(await attention(t.id)).toHaveLength(1);
    });
  });

  // ---- AS-60 ---------------------------------------------------------------------------------------------------

  describe('AS-60 auth failure and token refresh', () => {
    const read = {
      method: 'GET',
      path: '/shop.json',
      idempotent: true,
    } as const;

    it('S08 AS-60: a 401 with a refresh token causes exactly one refresh, the new token is stored sealed and the run succeeds', async () => {
      const t = await world({ pageSize: 10, refreshToken: 'shprt_0' });
      t.fake.addProduct({ title: 'Mug', stock: 2 });
      t.fake.expireAccessToken('shprt_0');

      expect(await engine.handle(incrementalMsg(t.id))).toBe('completed');

      expect(t.fake.refreshGrants).toHaveLength(1);
      const row = await rowOf(t.id);
      expect(row.status).toBe('ACTIVE');
      expect(row.credentialsSealed).not.toContain(t.fake.accessToken);
      const stored = parseCredentials(vault.open(t.id, row.credentialsSealed!));
      expect(stored).toMatchObject({
        provider: 'shopify',
        accessToken: t.fake.accessToken,
        refreshToken: t.fake.validRefreshToken,
      });
      expect(stored.provider === 'shopify' && stored.expiresAt).toBeTruthy();
    });

    it('S08 AS-60: two workers seeing the 401 at the same moment cause one refresh call and both continue with the new token', async () => {
      const t = await world({ pageSize: 10, refreshToken: 'shprt_0' });
      t.fake.expireAccessToken('shprt_0');
      t.fake.inject({
        match: (r) => r.path === '/admin/oauth/access_token',
        fault: { kind: 'delay', ms: 200 },
      });
      const record = await rowOf(t.id);
      const first = sessions.forIntegration(record);
      const second = sessions.forIntegration(record);

      const [a, b] = await Promise.all([
        first.call.call(read),
        second.call.call(read),
      ]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(t.fake.refreshGrants).toHaveLength(1);
    });

    it.each([
      [
        'there is no refresh token',
        undefined,
        (f: FakeShopify) => f.expireAccessToken(),
      ],
      [
        'the refresh is refused',
        'shprt_old',
        (f: FakeShopify) => f.expireAccessToken('some-other-token'),
      ],
    ])(
      'S08 AS-60: when %s the integration becomes NEEDS_REAUTH with history, one status event, one attention event, and the scheduler skips it',
      async (_name, refreshToken, expire) => {
        const t = await world({
          pageSize: 10,
          ...(refreshToken ? { refreshToken } : {}),
        });
        expire(t.fake);

        expect(await engine.handle(incrementalMsg(t.id))).toBe('failed');

        const row = await rowOf(t.id);
        expect(row.status).toBe('NEEDS_REAUTH');
        expect(row.lastError).toBe('provider_auth_failed');
        expect((await history(t.id)).at(-1)).toMatchObject({
          fromStatus: 'ACTIVE',
          toStatus: 'NEEDS_REAUTH',
          reason: 'auth_failed',
        });
        const status = await events(
          t.id,
          'catalogsync.integration_status_changed',
        );
        expect(status.map((e) => e.payload.payload)).toEqual([
          expect.objectContaining({
            from: 'ACTIVE',
            to: 'NEEDS_REAUTH',
            reason: 'auth_failed',
          }),
        ]);
        expect(await attention(t.id)).toEqual([
          expect.objectContaining({ reason: 'needs_reauth' }),
        ]);
        expect(t.fake.refreshGrants).toHaveLength(refreshToken ? 1 : 0);

        const requests = t.fake.requests.length;
        expect(await engine.handle(incrementalMsg(t.id))).toBe('ignored');
        expect(t.fake.requests.length).toBe(requests);
        await integrations.setNextSync(
          t.id,
          new Date(ctx.clock.now().getTime() - 1_000),
        );
        await jobs.syncAll();
        expect(messagesTo(t.id)).toHaveLength(0);
      },
    );

    it('S08 AS-60: two runs failing with 401 at the same moment still write exactly one status event and one attention event', async () => {
      const t = await world({ pageSize: 10 });
      t.fake.expireAccessToken();

      await Promise.all([
        engine.handle(oneMsg(t.id, '1:1')),
        engine.handle(oneMsg(t.id, '2:2')),
      ]);

      expect((await rowOf(t.id)).status).toBe('NEEDS_REAUTH');
      expect(
        await events(t.id, 'catalogsync.integration_status_changed'),
      ).toHaveLength(1);
      expect(await attention(t.id)).toHaveLength(1);
      expect(await history(t.id)).toHaveLength(2); // connect + auth_failed
    });
  });
});
