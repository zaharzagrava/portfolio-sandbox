import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { integrationEventSchemas } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import { SecretBox } from '@app/domains/identity';
import { readTopic } from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsProjectorModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { IntegrationAdminService } from './application/integration-admin.service';
import { WebhookService } from './application/webhook.service';
import { LagMonitorService } from './application/lag-monitor.service';
import { LifecycleService } from './application/lifecycle.service';
import { RetentionService } from './application/retention.service';
import { StockSyncService } from './application/stock-sync.service';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import {
  CATALOG_GATEWAY,
  CONFLICT_REPOSITORY,
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INSTALL_REPOSITORY,
  INTEGRATION_REPOSITORY,
  LINK_REPOSITORY,
  QUARANTINE_REPOSITORY,
  RECEIPT_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  type CatalogGateway,
  type ConflictRepository,
  type CredentialVault,
  type CursorRepository,
  type InstallRepository,
  type IntegrationRepository,
  type LinkRepository,
  type QuarantineRepository,
  type ReceiptRepository,
  type ReconciliationRepository,
  type SyncMessage,
} from './domain/ports';
import { CatalogServicesGateway } from './infra/catalog-gateway.adapter';
import { IntegrationsJobs } from './infra/integrations.jobs';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import {
  TenancyOffboardingConsumer,
  TenancyShopDeletedConsumer,
} from './infra/tenancy-events.consumer';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const MIN = 60_000;
const DAY = 86_400_000;
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';
const TOPIC = 'catalogsync.events';

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

describe('Integration lifecycle and events', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let engine: SyncEngineService;
  let lifecycle: LifecycleService;
  let retention: RetentionService;
  let offboarding: TenancyOffboardingConsumer;
  let deletedConsumer: TenancyShopDeletedConsumer;
  let admin: IntegrationAdminService;
  let lag: LagMonitorService;
  let stock: StockSyncService;
  let jobs: IntegrationsJobs;
  let integrations: IntegrationRepository;
  let cursors: CursorRepository;
  let links: LinkRepository;
  let quarantine: QuarantineRepository;
  let conflicts: ConflictRepository;
  let receipts: ReceiptRepository;
  let installs: InstallRepository;
  let reports: ReconciliationRepository;
  let vault: CredentialVault;
  let gateway: CatalogGateway;
  let enqueue: jest.SpyInstance;
  let upsertSpy: jest.SpyInstance;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];
  const extraShops: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        IntegrationsModule,
        IntegrationsWorkerModule,
        IntegrationsProjectorModule,
      ],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    const projector = ctx.app.select(IntegrationsProjectorModule);
    engine = worker.get(SyncEngineService);
    lifecycle = projector.get(LifecycleService);
    retention = worker.get(RetentionService);
    admin = worker.get(IntegrationAdminService);
    lag = worker.get(LagMonitorService);
    stock = worker.get(StockSyncService);
    jobs = worker.get(IntegrationsJobs);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    cursors = worker.get(CURSOR_REPOSITORY);
    links = worker.get(LINK_REPOSITORY);
    quarantine = worker.get(QUARANTINE_REPOSITORY);
    conflicts = worker.get(CONFLICT_REPOSITORY);
    receipts = worker.get(RECEIPT_REPOSITORY);
    installs = worker.get(INSTALL_REPOSITORY);
    reports = worker.get(RECONCILIATION_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    gateway = worker.get(CATALOG_GATEWAY);
    offboarding = projector.get(TenancyOffboardingConsumer);
    deletedConsumer = projector.get(TenancyShopDeletedConsumer);
    upsertSpy = jest.spyOn(gateway, 'upsertItems');
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    enqueue.mockClear();
    upsertSpy.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    upsertSpy.mockRestore();
    upsertSpy = jest.spyOn(gateway, 'upsertItems');
    for (const f of fakes.splice(0)) await f.stop();
    await db.query(
      `DROP TRIGGER IF EXISTS s08_batch_receipt_trg ON "WebhookReceipt"`,
    );
    await db.query(`DROP FUNCTION IF EXISTS s08_count_batch()`);
    await db.query(`DROP TABLE IF EXISTS s08_purge_batches`);
    if (integrationIds.length) await wipe(integrationIds);
    integrationIds.length = 0;
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function wipe(ids: string[]) {
    const replacements = { ids };
    for (const table of [
      'SyncRun',
      'SyncCursor',
      'ExternalLink',
      'SyncQuarantine',
      'StockConflict',
      'CatalogReconciliationRun',
      'WebhookReceipt',
      'IntegrationHistory',
    ])
      await db.query(`DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`, {
        replacements,
      });
    await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
      replacements,
    });
    await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
      replacements,
    });
  }

  /** The second statement that deletes webhook receipts fails (a connection lost half way through a purge). */
  function failSecondReceiptDelete(): () => void {
    const original = db.query;
    let calls = 0;
    db.query = ((sql: unknown, ...rest: unknown[]) => {
      if (
        typeof sql === 'string' &&
        /DELETE FROM "WebhookReceipt"/.test(sql) &&
        ++calls === 2
      )
        return Promise.reject(new Error('connection lost'));
      return (original as (...a: unknown[]) => unknown).call(db, sql, ...rest);
    }) as never;
    return () => {
      db.query = original;
    };
  }

  async function newShop() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    extraShops.push(shop.id);
    return { shopId: shop.id, owner };
  }

  async function newStore(pageSize = 2) {
    const domain = `life-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({ shopDomain: domain, pageSize });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    return { fake, domain };
  }

  /** An ACTIVE integration of `shopId` (a fresh shop when omitted) against its own fake store. */
  async function world(
    options: { shopId?: string; owner?: TestUser; pageSize?: number } = {},
  ) {
    const own =
      options.shopId && options.owner
        ? { shopId: options.shopId, owner: options.owner }
        : await newShop();
    const { fake, domain } = await newStore(options.pageSize);
    const id = randomUUID();
    const inserted = await integrations.insertConnected({
      id,
      shopId: own.shopId,
      provider: 'shopify',
      externalShop: domain,
      credentialsSealed: vault.seal(
        id,
        serialiseCredentials({
          provider: 'shopify',
          accessToken: fake.accessToken,
          scope: SCOPES,
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: own.owner.id,
      now: ctx.clock.now(),
      maxPerShop: 20,
    });
    expect(inserted.kind).toBe('inserted');
    integrationIds.push(id);
    return { shopId: own.shopId, owner: own.owner, fake, domain, id };
  }

  const msg = (integrationId: string, kind: SyncMessage['kind']): SyncMessage =>
    ({ integrationId, kind }) as SyncMessage;

  const rowOf = async (id: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "Integration" WHERE "id" = :id`,
        {
          type: QueryTypes.SELECT,
          replacements: { id },
        },
      )
    )[0];

  const countWhere = async (table: string, column: string, ids: string[]) =>
    Number(
      (
        await db.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE "${column}" IN (:ids)`,
          { type: QueryTypes.SELECT, replacements: { ids } },
        )
      )[0].n,
    );

  const outboxOf = async (aggregateId: string, type?: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = :aggregateId ${type ? `AND "type" = :type` : ''} ORDER BY "createdAt", "id"`,
      { type: QueryTypes.SELECT, replacements: { aggregateId, type } },
    );

  const historyOf = (id: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationHistory" WHERE "integrationId" = :id AND "reason" IN ('shop_offboarding', 'offboarding_cancelled') ORDER BY "at", "id"`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );

  const startedEvent = (shopId: string) =>
    ShopOffboardingStarted.create(shopId, 3, {
      shopId,
      purgeAt: new Date(ctx.clock.now().getTime() + 30 * DAY).toISOString(),
      shopVersion: 3,
    });
  const cancelledEvent = (shopId: string) =>
    ShopOffboardingCancelled.create(shopId, 4, { shopId, shopVersion: 4 });
  const deletedEvent = (shopId: string) =>
    ShopDeleted.create(shopId, 5, { shopId, shopVersion: 5 });

  async function pauseBySeller(id: string) {
    await integrations.transition(id, 'ACTIVE', 'PAUSED', {
      reason: 'pause',
      actorId: null,
      now: ctx.clock.now(),
      pausedReason: 'seller',
    });
  }

  // ---- AS-73 ---------------------------------------------------------------------------------------------------

  describe('shop not active (AS-73)', () => {
    it('S08 AS-73: a shop that is not ACTIVE makes the run end skipped_shop_not_active with no provider call, no failure counted and no breaker movement', async () => {
      const w = await world();
      w.fake.addProduct({ title: 'Mug', stock: 1 });
      await tenancy.setShopStatus(w.shopId, 'SUSPENDED');

      for (const kind of ['incremental', 'backfill'] as const)
        expect(await engine.handle(msg(w.id, kind))).toBe(
          'skipped_shop_not_active',
        );

      expect(w.fake.requests).toHaveLength(0);
      expect(upsertSpy).not.toHaveBeenCalled();
      const runs = await db.query<Record<string, any>>(
        `SELECT "outcome" FROM "SyncRun" WHERE "integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: w.id } },
      );
      expect(runs.map((r) => r.outcome)).toEqual([
        'skipped_shop_not_active',
        'skipped_shop_not_active',
      ]);
      const row = await rowOf(w.id);
      expect(row).toMatchObject({
        status: 'ACTIVE',
        consecutiveFailures: 0,
        breakerOpenUntil: null,
        lastError: null,
      });
      expect(await outboxOf(w.id)).toHaveLength(0);
    });

    it('S08 AS-73: a suspension between two pages ends the run skipped, counts no failure, and the next pull after reinstatement continues from the checkpoint', async () => {
      const w = await world({ pageSize: 2 });
      for (let i = 1; i <= 5; i++)
        w.fake.addProduct({ title: `P${i}`, stock: i });
      const original = (...args: Parameters<CatalogGateway['upsertItems']>) =>
        CatalogServicesGateway.prototype.upsertItems.apply(gateway, args);
      let calls = 0;
      upsertSpy.mockImplementation(
        async (...args: Parameters<CatalogGateway['upsertItems']>) => {
          if (++calls === 2) await tenancy.setShopStatus(w.shopId, 'SUSPENDED');
          return original(...args);
        },
      );

      expect(await engine.handle(msg(w.id, 'backfill'))).toBe(
        'skipped_shop_not_active',
      );

      expect(await rowOf(w.id)).toMatchObject({
        status: 'ACTIVE',
        consecutiveFailures: 0,
        breakerOpenUntil: null,
      });
      const checkpoint = (await cursors.read(w.id, 'product'))!;
      expect(checkpoint.pageCursor).not.toBeNull();
      const linked = await countWhere('ExternalLink', 'integrationId', [w.id]);
      expect(linked).toBe(2); // only the first page was written

      await tenancy.setShopStatus(w.shopId, 'ACTIVE');
      upsertSpy.mockImplementation(original);
      const requestsBefore = w.fake.requests.length;
      expect(await engine.handle(msg(w.id, 'incremental'))).toMatch(
        /^completed/,
      );

      const listRequests = w.fake.requests
        .slice(requestsBefore)
        .filter((r) => r.method === 'GET' && /\/products\.json$/.test(r.path));
      expect(listRequests.length).toBeGreaterThan(0);
      expect(listRequests[0].query.page_info).toBeDefined(); // resumed at the page cursor, not from the start
      expect(await countWhere('ExternalLink', 'integrationId', [w.id])).toBe(5);
    });
  });

  // ---- AS-74 ---------------------------------------------------------------------------------------------------

  describe('shop offboarding (AS-74, AS-77)', () => {
    async function shopWithThree() {
      const a = await world();
      const b = await world({ shopId: a.shopId, owner: a.owner });
      const c = await world({ shopId: a.shopId, owner: a.owner });
      const other = await world();
      await pauseBySeller(b.id);
      return { a, b, c, other, shopId: a.shopId };
    }

    it('S08 AS-74: offboarding started pauses the ACTIVE integrations of that shop only, keeps the seller pause, writes history and one status event each; a second delivery changes nothing', async () => {
      const { a, b, c, other, shopId } = await shopWithThree();

      await offboarding.project([startedEvent(shopId)]);

      expect(await rowOf(a.id)).toMatchObject({
        status: 'PAUSED',
        pausedReason: 'shop_offboarding',
      });
      expect(await rowOf(c.id)).toMatchObject({
        status: 'PAUSED',
        pausedReason: 'shop_offboarding',
      });
      expect(await rowOf(b.id)).toMatchObject({
        status: 'PAUSED',
        pausedReason: 'seller',
      });
      expect(await rowOf(other.id)).toMatchObject({
        status: 'ACTIVE',
        pausedReason: null,
      });
      for (const id of [a.id, c.id]) {
        const history = await historyOf(id);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          fromStatus: 'ACTIVE',
          toStatus: 'PAUSED',
          reason: 'shop_offboarding',
        });
        const events = await outboxOf(
          id,
          'catalogsync.integration_status_changed',
        );
        expect(events).toHaveLength(1);
        expect(events[0].payload.payload).toMatchObject({
          integrationId: id,
          shopId,
          from: 'ACTIVE',
          to: 'PAUSED',
          reason: 'shop_offboarding',
        });
      }
      expect(await historyOf(b.id)).toHaveLength(0);
      expect(await outboxOf(b.id)).toHaveLength(0);
      expect(await outboxOf(other.id)).toHaveLength(0);

      await offboarding.project([startedEvent(shopId)]);
      await lifecycle.offboardingStarted(shopId);
      for (const id of [a.id, c.id]) {
        expect(await historyOf(id)).toHaveLength(1);
        expect(
          await outboxOf(id, 'catalogsync.integration_status_changed'),
        ).toHaveLength(1);
      }
    });

    it('S08 AS-74: offboarding cancelled resumes only the integrations paused for the offboarding, with the catch-up pull and reconcile, once', async () => {
      const { a, b, c, other, shopId } = await shopWithThree();
      await offboarding.project([startedEvent(shopId)]);
      enqueue.mockClear();

      await offboarding.project([cancelledEvent(shopId)]);

      expect(await rowOf(a.id)).toMatchObject({
        status: 'ACTIVE',
        pausedReason: null,
      });
      expect(await rowOf(c.id)).toMatchObject({
        status: 'ACTIVE',
        pausedReason: null,
      });
      expect(await rowOf(b.id)).toMatchObject({
        status: 'PAUSED',
        pausedReason: 'seller',
      });
      expect(await rowOf(other.id)).toMatchObject({ status: 'ACTIVE' });
      const queued = enqueue.mock.calls
        .filter(
          ([q]) => q === 'integration-sync' || q === 'integration-backfill',
        )
        .map(([q, body]) => `${q}:${body.integrationId}:${body.kind}`)
        .sort();
      expect(queued).toEqual(
        [
          `integration-sync:${a.id}:incremental`,
          `integration-backfill:${a.id}:reconcile`,
          `integration-sync:${c.id}:incremental`,
          `integration-backfill:${c.id}:reconcile`,
        ].sort(),
      );
      const events = await outboxOf(
        a.id,
        'catalogsync.integration_status_changed',
      );
      expect(events.map((e) => e.payload.payload)).toEqual([
        expect.objectContaining({
          from: 'ACTIVE',
          to: 'PAUSED',
          reason: 'shop_offboarding',
        }),
        expect.objectContaining({
          from: 'PAUSED',
          to: 'ACTIVE',
          reason: 'offboarding_cancelled',
        }),
      ]);

      enqueue.mockClear();
      await offboarding.project([cancelledEvent(shopId)]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(
        await outboxOf(a.id, 'catalogsync.integration_status_changed'),
      ).toHaveLength(2);
      expect(await historyOf(a.id)).toHaveLength(2);
    });

    it('S08 AS-74: an invalid offboarding payload is refused as permanent and changes nothing', async () => {
      const { a } = await shopWithThree();
      const bad = {
        ...startedEvent(a.shopId),
        payload: { shopId: 'not-a-uuid', purgeAt: 'x', shopVersion: 'y' },
      };
      await expect(offboarding.project([bad])).rejects.toBeInstanceOf(
        PermanentError,
      );
      expect(await rowOf(a.id)).toMatchObject({ status: 'ACTIVE' });
    });

    it('S08 AS-77: the status change and its outbox row commit together; a failing append leaves neither the status nor a history row', async () => {
      const { a, shopId } = await shopWithThree();
      const outbox = ctx.app
        .select(IntegrationsProjectorModule)
        .get(OutboxService);
      const spy = jest
        .spyOn(outbox, 'append')
        .mockRejectedValueOnce(new Error('outbox down'));

      await expect(offboarding.project([startedEvent(shopId)])).rejects.toThrow(
        'outbox down',
      );

      spy.mockRestore();
      expect(await rowOf(a.id)).toMatchObject({
        status: 'ACTIVE',
        pausedReason: null,
      });
      expect(await historyOf(a.id)).toHaveLength(0);
      expect(await outboxOf(a.id)).toHaveLength(0);
    });
  });

  describe('lifecycle events (AS-77)', () => {
    it('S08 AS-77: pause, resume and disconnect each write exactly one schema-valid event on catalogsync.events keyed by the integration; a refused pause, a repeat disconnect and a no-op write none', async () => {
      const w = await world();
      const shop = w.shopId;
      const base = `/api/shops/${shop}/integrations/${w.id}`;

      expect((await ctx.as(w.owner).post(`${base}/pause`)).status).toBe(200);
      expect((await ctx.as(w.owner).post(`${base}/pause`)).status).toBe(409);
      expect((await ctx.as(w.owner).post(`${base}/resume`)).status).toBe(200);
      expect((await ctx.as(w.owner).post(`${base}/resume`)).status).toBe(409);
      expect((await ctx.as(w.owner).delete(base)).status).toBe(204);
      expect((await ctx.as(w.owner).delete(base)).status).toBe(204);
      await offboarding.project([cancelledEvent(shop)]); // nothing is paused for the offboarding: a no-op

      const rows = await outboxOf(w.id);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => [r.type, r.topic, r.aggregateId])).toEqual(
        Array(3).fill(['catalogsync.integration_status_changed', TOPIC, w.id]),
      );
      expect(rows.map((r) => r.payload.payload.reason)).toEqual([
        'seller',
        'seller',
        'disconnected',
      ]);
      for (const row of rows) {
        const envelope = row.payload;
        expect(Object.keys(envelope)).toEqual(
          expect.arrayContaining([
            'eventId',
            'type',
            'version',
            'occurredAt',
            'aggregateId',
          ]),
        );
        expect(envelope.version).toBe(1);
        expect(envelope.aggregateId).toBe(w.id);
        expect(
          integrationEventSchemas[
            'catalogsync.integration_status_changed'
          ].safeParse(envelope).success,
        ).toBe(true);
      }
      expect(new Set(rows.map((r) => r.payload.eventId)).size).toBe(3);
    });

    it('S08 AS-77: an attention event and its status event are one pair per fault and parse with their schemas', async () => {
      const w = await world();
      const other = await world();
      const stolen = (await rowOf(other.id)).credentialsSealed as string;
      await db.query(
        `UPDATE "Integration" SET "credentialsSealed" = :stolen WHERE "id" = :id`,
        {
          replacements: { stolen, id: w.id },
        },
      );

      await engine.handle(msg(w.id, 'incremental'));
      await engine.handle(msg(w.id, 'incremental')); // no longer ACTIVE: acknowledged, nothing more

      const rows = await outboxOf(w.id);
      expect(rows.map((r) => r.type).sort()).toEqual([
        'catalogsync.integration_attention_required',
        'catalogsync.integration_status_changed',
      ]);
      for (const row of rows)
        expect(
          integrationEventSchemas[
            row.type as keyof typeof integrationEventSchemas
          ].safeParse(row.payload).success,
        ).toBe(true);
    });
  });

  // ---- AS-75 ---------------------------------------------------------------------------------------------------

  describe('shop deleted (AS-75)', () => {
    async function populated(
      shopId: string,
      owner: TestUser,
      receiptCount = 0,
    ) {
      const w = await world({ shopId, owner, pageSize: 2 });
      w.fake.addProduct({ title: 'A', stock: 2 });
      w.fake.addProduct({ title: 'B', stock: 3 });
      w.fake.addProduct({ title: 'Broken', price: 'free', stock: 1 });
      await engine.handle(msg(w.id, 'backfill'));
      await quarantine.record(
        {
          integrationId: w.id,
          entity: 'product',
          externalId: 'q1',
          dedupeKey: 'q1',
          payloadDigest: null,
          reasonCode: 'invalid_price',
          message: 'x',
          payload: { a: 1 },
        },
        ctx.clock.now(),
      );
      await conflicts.open(
        {
          integrationId: w.id,
          shopId,
          externalId: '1:1',
          productId: null,
          kind: 'oversold',
          base: 5,
          local: 1,
          remote: 2,
          merged: 0,
          resolvedTo: 0,
        },
        ctx.clock.now(),
      );
      const report = await reports.start(w.id, ctx.clock.now(), null);
      await reports.finish(
        report,
        { outcome: 'completed', counts: {}, findings: [] },
        ctx.clock.now(),
      );
      await receipts.insertIfNew(w.id, 'delivery-1', ctx.clock.now());
      if (receiptCount)
        await db.query(
          `INSERT INTO "WebhookReceipt" ("integrationId", "deliveryId", "receivedAt")
           SELECT :id, 'bulk-' || g, now() FROM generate_series(1, :n) g`,
          { replacements: { id: w.id, n: receiptCount } },
        );
      await installs.create(
        {
          shopId,
          userId: w.owner.id,
          shopDomain: w.domain,
          stateDigest: randomUUID(),
        },
        ctx.clock.now(),
      );
      return w;
    }

    const TABLES = [
      'Integration',
      'ExternalLink',
      'SyncCursor',
      'SyncRun',
      'SyncQuarantine',
      'StockConflict',
      'CatalogReconciliationRun',
      'WebhookReceipt',
      'IntegrationHistory',
    ] as const;
    const footprint = async (ids: string[]) =>
      Object.fromEntries(
        await Promise.all(
          TABLES.map(async (t) => [
            t,
            await countWhere(
              t,
              t === 'Integration' ? 'id' : 'integrationId',
              ids,
            ),
          ]),
        ),
      ) as Record<(typeof TABLES)[number], number>;
    const installsOf = (shopId: string) =>
      countWhere('IntegrationInstall', 'shopId', [shopId]);
    const productsOf = (shopId: string) =>
      countWhere('Product', 'shopId', [shopId]);

    it('S08 AS-75: shop_deleted removes every row of the shop in statements of at most 1,000 rows, erases the credentials, leaves other shops and the products alone; a redelivery changes nothing', async () => {
      const x = await newShop();
      const y = await newShop();
      const x1 = await populated(x.shopId, x.owner, 2_500);
      const x2 = await populated(x.shopId, x.owner);
      const y1 = await populated(y.shopId, y.owner);
      const xIds = [x1.id, x2.id];
      const before = await footprint([y1.id]);
      const productsX = await productsOf(x.shopId);
      const productsY = await productsOf(y.shopId);
      expect(productsX).toBe(4);
      expect(await footprint(xIds)).toMatchObject({
        Integration: 2,
        ExternalLink: 4,
        WebhookReceipt: 2_502,
      });
      expect(await installsOf(x.shopId)).toBe(2);
      upsertSpy.mockClear();

      await db.query(`CREATE TABLE s08_purge_batches (tbl text, n int)`);
      await db.query(`
        CREATE FUNCTION s08_count_batch() RETURNS trigger AS $$
        BEGIN INSERT INTO s08_purge_batches SELECT TG_TABLE_NAME, count(*) FROM old_rows HAVING count(*) > 0; RETURN NULL; END
        $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER s08_batch_receipt_trg AFTER DELETE ON "WebhookReceipt"
        REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION s08_count_batch()`);

      await deletedConsumer.project([deletedEvent(x.shopId)]);

      const batches = (
        await db.query<{ n: number }>(
          `SELECT n FROM s08_purge_batches ORDER BY n DESC`,
          { type: QueryTypes.SELECT },
        )
      ).map((b) => Number(b.n));
      expect(batches.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...batches)).toBeLessThanOrEqual(1_000);
      expect(batches.reduce((a, b) => a + b, 0)).toBe(2_502);

      expect(await footprint(xIds)).toEqual(
        Object.fromEntries(TABLES.map((t) => [t, 0])),
      );
      expect(await installsOf(x.shopId)).toBe(0);
      expect(await footprint([y1.id])).toEqual(before);
      expect(await installsOf(y.shopId)).toBe(1);
      expect(await rowOf(y1.id)).toMatchObject({ status: 'ACTIVE' });
      expect((await rowOf(y1.id)).credentialsSealed).not.toBeNull();
      expect(await productsOf(x.shopId)).toBe(productsX); // the catalog's own reaction owns them
      expect(await productsOf(y.shopId)).toBe(productsY);
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(await engine.handle(msg(x1.id, 'incremental'))).toBe('ignored'); // queued messages become no-ops

      await db.query(`DELETE FROM s08_purge_batches`);
      await deletedConsumer.project([deletedEvent(x.shopId)]);
      await lifecycle.purgeShop(x.shopId);
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM s08_purge_batches`,
              { type: QueryTypes.SELECT },
            )
          )[0].n,
        ),
      ).toBe(0);
      expect(await footprint([y1.id])).toEqual(before);
    });

    it('S08 AS-75: a purge that fails half way is finished by the redelivery', async () => {
      const x = await newShop();
      const x1 = await populated(x.shopId, x.owner, 1_500);
      const restore = failSecondReceiptDelete();
      try {
        await expect(
          deletedConsumer.project([deletedEvent(x.shopId)]),
        ).rejects.toThrow('connection lost');
      } finally {
        restore();
      }
      expect(
        await countWhere('WebhookReceipt', 'integrationId', [x1.id]),
      ).toBeGreaterThan(0);

      await deletedConsumer.project([deletedEvent(x.shopId)]);
      expect(await rowOf(x1.id)).toBeUndefined();
      expect(await countWhere('WebhookReceipt', 'integrationId', [x1.id])).toBe(
        0,
      );
    });

    it('S08 AS-75: credentials are erased first, so a purge interrupted after its first batch leaves no secret behind', async () => {
      const x = await newShop();
      const x1 = await populated(x.shopId, x.owner, 1_200);
      const restore = failSecondReceiptDelete();
      try {
        await expect(lifecycle.purgeShop(x.shopId)).rejects.toThrow(
          'connection lost',
        );
      } finally {
        restore();
      }

      const row = await rowOf(x1.id);
      expect(row).toBeDefined();
      expect(row.credentialsSealed).toBeNull();
      await lifecycle.purgeShop(x.shopId);
      expect(await rowOf(x1.id)).toBeUndefined();
    });
  });

  // ---- AS-76 ---------------------------------------------------------------------------------------------------

  describe('retention (AS-76)', () => {
    const ago = (ms: number) => new Date(ctx.clock.now().getTime() - ms);

    /** Everything the job could delete or close, whoever left it, goes first so exact counts are ours. */
    async function drain() {
      for (let i = 0; i < 20; i++) {
        const r = await retention.run();
        if (Object.values(r).every((n) => n === 0)) return;
      }
      throw new Error('retention never drained');
    }

    async function seedQuarantine(
      integrationId: string,
      key: string,
      status: string,
      ageMs: number,
    ) {
      const at = ago(ageMs);
      await db.query(
        `INSERT INTO "SyncQuarantine" ("integrationId","entity","externalId","dedupeKey","reasonCode","message","payload","status",
           "resolution","firstSeenAt","lastSeenAt","resolvedAt","createdAt")
         VALUES (:integrationId,'product',:key,:key,'invalid_price','m','{}'::jsonb,:status,
           :resolution,:at,:at,:resolvedAt,:at)`,
        {
          replacements: {
            integrationId,
            key,
            status,
            at,
            resolution:
              status === 'OPEN'
                ? null
                : status === 'RESOLVED'
                  ? 'fixed_at_provider'
                  : 'dismissed',
            resolvedAt: status === 'OPEN' ? null : at,
          },
        },
      );
    }

    async function seedConflict(
      integrationId: string,
      shopId: string,
      n: number,
      status: string,
      ageMs: number,
    ) {
      const at = ago(ageMs);
      await db.query(
        `INSERT INTO "StockConflict" ("integrationId","shopId","externalId","kind","base","local","remote","status","createdAt","dismissedAt","resolution")
         VALUES (:integrationId,:shopId,:ext,'oversold',:n,1,2,:status,:at,:dismissedAt,:resolution)`,
        {
          replacements: {
            integrationId,
            shopId,
            ext: `c${n}`,
            n,
            status,
            at,
            dismissedAt: status === 'DISMISSED' ? at : null,
            resolution: status === 'DISMISSED' ? 'dismissed' : null,
          },
        },
      );
    }

    const statusOf = async (table: string, key: string, id: string) =>
      db.query<Record<string, any>>(
        `SELECT * FROM "${table}" WHERE "integrationId" = :id AND "${key}" IS NOT NULL ORDER BY 1`,
        {
          type: QueryTypes.SELECT,
          replacements: { id },
        },
      );

    it('S08 AS-76: records of every age lose exactly the rows the rules name, open items past 90 days are closed as expired, and a second run does nothing', async () => {
      await drain();
      const w = await world();
      const id = w.id;

      for (const [d, age] of [
        ['old-1', 8 * DAY],
        ['old-2', 8 * DAY],
        ['new-1', 6 * DAY],
        ['new-2', DAY],
      ] as const)
        await receipts.insertIfNew(id, d, ago(age));
      for (const [age, kind] of [
        [31 * DAY, 'incremental'],
        [31 * DAY, 'backfill'],
        [29 * DAY, 'incremental'],
      ] as const)
        await db.query(
          `INSERT INTO "SyncRun" ("integrationId","kind","startedAt","finishedAt","outcome") VALUES (:id,:kind,:at,:at,'completed')`,
          {
            replacements: { id, kind, at: ago(age) },
          },
        );
      await seedQuarantine(id, 'res-old', 'RESOLVED', 31 * DAY);
      await seedQuarantine(id, 'dis-old', 'DISMISSED', 31 * DAY);
      await seedQuarantine(id, 'res-new', 'RESOLVED', 29 * DAY);
      await seedQuarantine(id, 'open-mid', 'OPEN', 31 * DAY);
      await seedQuarantine(id, 'open-ancient', 'OPEN', 91 * DAY);
      await seedConflict(id, w.shopId, 1, 'DISMISSED', 31 * DAY);
      await seedConflict(id, w.shopId, 2, 'DISMISSED', 29 * DAY);
      await seedConflict(id, w.shopId, 3, 'OPEN', 31 * DAY);
      await seedConflict(id, w.shopId, 4, 'OPEN', 91 * DAY);
      for (const [age, expiresIn] of [
        [3 * DAY, -2 * DAY],
        [3 * DAY, -12 * 60 * MIN],
        [3 * DAY, 5 * MIN],
      ] as const)
        await db.query(
          `INSERT INTO "IntegrationInstall" ("shopId","userId","shopDomain","stateDigest","expiresAt","createdAt") VALUES (:s,:u,'a.myshopify.com',:d,:e,:c)`,
          {
            replacements: {
              s: w.shopId,
              u: w.owner.id,
              d: randomUUID(),
              e: new Date(ctx.clock.now().getTime() + expiresIn),
              c: ago(age),
            },
          },
        );
      for (const age of [91 * DAY, 89 * DAY]) {
        const run = await reports.start(id, ago(age), null);
        await reports.finish(
          run,
          { outcome: 'completed', counts: {}, findings: [] },
          ago(age),
        );
      }

      const first = await retention.run();

      expect(first).toEqual({
        receipts: 2,
        runs: 2,
        quarantine: 2,
        conflicts: 1,
        installs: 1,
        reports: 1,
        expired: 2,
      });
      expect(
        (await statusOf('WebhookReceipt', 'deliveryId', id))
          .map((r) => r.deliveryId)
          .sort(),
      ).toEqual(['new-1', 'new-2']);
      expect(await countWhere('SyncRun', 'integrationId', [id])).toBe(1);
      const q = await statusOf('SyncQuarantine', 'dedupeKey', id);
      expect(
        q.map((r) => [r.dedupeKey, r.status, r.resolution]).sort(),
      ).toEqual([
        ['open-ancient', 'DISMISSED', 'expired'],
        ['open-mid', 'OPEN', null],
        ['res-new', 'RESOLVED', 'fixed_at_provider'],
      ]);
      const c = await statusOf('StockConflict', 'externalId', id);
      expect(
        c.map((r) => [r.externalId, r.status, r.resolution]).sort(),
      ).toEqual([
        ['c2', 'DISMISSED', 'dismissed'],
        ['c3', 'OPEN', null],
        ['c4', 'DISMISSED', 'expired'],
      ]);
      expect(await countWhere('IntegrationInstall', 'shopId', [w.shopId])).toBe(
        2,
      );
      expect(
        await countWhere('CatalogReconciliationRun', 'integrationId', [id]),
      ).toBe(1);

      const second = await retention.run();
      expect(second).toEqual({
        receipts: 0,
        runs: 0,
        quarantine: 0,
        conflicts: 0,
        installs: 0,
        reports: 0,
        expired: 0,
      });
      expect(await countWhere('SyncQuarantine', 'integrationId', [id])).toBe(3);

      // The scheduled job is this service.
      await db.query(`DELETE FROM "IntegrationInstall" WHERE "shopId" = :s`, {
        replacements: { s: w.shopId },
      });
    });

    it('S08 AS-76: at most 5,000 rows of a kind go per run, oldest first, and the next run takes the rest', async () => {
      await drain();
      const w = await world();
      await db.query(
        `INSERT INTO "WebhookReceipt" ("integrationId","deliveryId","receivedAt")
         SELECT :id, 'r-' || lpad(g::text, 5, '0'), :base::timestamptz - (:n - g) * interval '1 second' - interval '400 days'
           FROM generate_series(1, :n) g`,
        { replacements: { id: w.id, n: 5_010, base: ctx.clock.now() } },
      );

      const first = await retention.run();

      expect(first.receipts).toBe(5_000);
      const left = await db.query<{ deliveryId: string }>(
        `SELECT "deliveryId" FROM "WebhookReceipt" WHERE "integrationId" = :id ORDER BY "deliveryId"`,
        { type: QueryTypes.SELECT, replacements: { id: w.id } },
      );
      expect(left.map((r) => r.deliveryId)).toEqual(
        Array.from(
          { length: 10 },
          (_, i) => `r-${String(5_001 + i).padStart(5, '0')}`,
        ),
      );
      expect((await retention.run()).receipts).toBe(10);
      expect((await retention.run()).receipts).toBe(0);
    });

    it('S08 AS-76: the scheduled job catalog-sync.purge-integration-data runs the retention service', async () => {
      const spy = jest.spyOn(RetentionService.prototype, 'run');
      const result = await jobs.purgeIntegrationData();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          receipts: expect.any(Number),
          runs: expect.any(Number),
          reports: expect.any(Number),
        }),
      );
      spy.mockRestore();
    });
  });

  // ---- AS-78 ---------------------------------------------------------------------------------------------------

  describe('observability (AS-78)', () => {
    const FR102 = [
      'catalog_sync_runs_total',
      'catalog_sync_lag_seconds',
      'catalog_sync_items_total',
      'catalog_sync_provider_calls_total',
      'catalog_sync_provider_429_total',
      'catalog_sync_echo_suppressed_total',
      'catalog_sync_quarantine_open',
      'catalog_sync_conflicts_open',
      'catalog_sync_webhooks_total',
      'catalog_sync_breaker_open',
      'catalog_sync_reconcile_findings_total',
    ];
    const value = (name: string, labels: Record<string, string> = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;

    /** Registering a name again with other labels only throws when the metric already exists. */
    const registered = (name: string) => {
      for (const make of [
        () =>
          MetricsRegistry.counter({
            name,
            help: 'probe',
            labels: ['probe_only'],
          }),
        () =>
          MetricsRegistry.gauge({
            name,
            help: 'probe',
            labels: ['probe_only'],
          }),
      ])
        try {
          make();
        } catch (error) {
          if (/already registered/.test(String(error))) return true;
        }
      return false;
    };

    it('S08 AS-78: every metric of FR-102 exists', () => {
      expect(FR102.filter((n) => !registered(n))).toEqual([]);
    });

    it('S08 AS-78: runs, items, provider calls, quarantine, conflicts, breaker, lag, echo and webhooks metrics move as the events happen', async () => {
      const w = await world({ pageSize: 5 });
      const old = (min: number) =>
        new Date(ctx.clock.now().getTime() - min * MIN);
      w.fake.addProduct({ title: 'A', stock: 2, updatedAt: old(100) });
      w.fake.addProduct({
        title: 'Bad',
        price: 'free',
        stock: 1,
        updatedAt: old(95),
      });
      w.fake.addProduct({ title: 'B', stock: 3, updatedAt: old(90) });
      const runs0 = value('catalog_sync_runs_total', {
        provider: 'shopify',
        kind: 'backfill',
        outcome: 'completed_with_quarantine',
      });
      const created0 = value('catalog_sync_items_total', {
        provider: 'shopify',
        result: 'created',
      });
      const quarantined0 = value('catalog_sync_items_total', {
        provider: 'shopify',
        result: 'quarantined',
      });
      const calls0 = value('catalog_sync_provider_calls_total', {
        provider: 'shopify',
        status: '200',
      });

      expect(await engine.handle(msg(w.id, 'backfill'))).toBe(
        'completed_with_quarantine',
      );

      expect(
        value('catalog_sync_runs_total', {
          provider: 'shopify',
          kind: 'backfill',
          outcome: 'completed_with_quarantine',
        }),
      ).toBe(runs0 + 1);
      expect(
        value('catalog_sync_items_total', {
          provider: 'shopify',
          result: 'created',
        }),
      ).toBe(created0 + 2);
      expect(
        value('catalog_sync_items_total', {
          provider: 'shopify',
          result: 'quarantined',
        }),
      ).toBe(quarantined0 + 1);
      expect(
        value('catalog_sync_provider_calls_total', {
          provider: 'shopify',
          status: '200',
        }),
      ).toBeGreaterThan(calls0);

      // Gauges are refreshed by the lag evaluation of the 5-minute job.
      await conflicts.open(
        {
          integrationId: w.id,
          shopId: w.shopId,
          externalId: '9:9',
          productId: null,
          kind: 'oversold',
          base: 5,
          local: 1,
          remote: 2,
          merged: 0,
          resolvedTo: 0,
        },
        ctx.clock.now(),
      );
      await integrations.saveBreaker(w.id, {
        failures: 5,
        openUntil: new Date(ctx.clock.now().getTime() + 5 * MIN),
        halfOpen: false,
        attentionRaised: true,
      });
      await lag.evaluate();
      expect(value('catalog_sync_quarantine_open')).toBeGreaterThanOrEqual(1);
      expect(value('catalog_sync_conflicts_open')).toBeGreaterThanOrEqual(1);
      expect(
        value('catalog_sync_breaker_open', { provider: 'shopify' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        value('catalog_sync_lag_seconds', { provider: 'shopify' }),
      ).toBeGreaterThanOrEqual(90 * 60);
      await integrations.saveBreaker(w.id, {
        failures: 0,
        openUntil: null,
        halfOpen: false,
        attentionRaised: false,
      });
      await lag.evaluate();
      expect(value('catalog_sync_breaker_open', { provider: 'shopify' })).toBe(
        0,
      );

      // An echo of our own apply is dropped and counted.
      const link = (
        await links.findMany(w.id, [...(await externalIds(w.id))], 'product')
      )
        .values()
        .next().value!;
      const echo0 = value('catalog_sync_echo_suppressed_total');
      await stock.pushLocal((await integrations.findById(w.id))!, link, {
        quantity: link.syncedStock!,
        version: 99,
      });
      expect(value('catalog_sync_echo_suppressed_total')).toBe(echo0 + 1);

      // A refused webhook is counted by result (the integration has no webhook secret for this id: it is a fake id).
      const webhooks0 = value('catalog_sync_webhooks_total', {
        provider: 'shopify',
        result: 'invalid_signature',
      });
      const webhookService = ctx.app.get(WebhookService, { strict: false });
      await expect(
        webhookService.accept(
          w.id,
          {
            'x-shopify-hmac-sha256': 'wrong',
            'x-shopify-topic': 'products/update',
          },
          Buffer.from('{}'),
        ),
      ).rejects.toBeDefined();
      expect(
        value('catalog_sync_webhooks_total', {
          provider: 'shopify',
          result: 'invalid_signature',
        }),
      ).toBe(webhooks0 + 1);
    });

    async function externalIds(integrationId: string) {
      return (
        await db.query<{ externalId: string }>(
          `SELECT "externalId" FROM "ExternalLink" WHERE "integrationId" = :integrationId ORDER BY "externalId"`,
          {
            type: QueryTypes.SELECT,
            replacements: { integrationId },
          },
        )
      ).map((r) => r.externalId);
    }

    it('S08 AS-78: no metric label of the capability carries an id, a token, a signature or a payload', () => {
      const allowedKeys = new Set([
        'provider',
        'kind',
        'outcome',
        'result',
        'status',
      ]);
      for (const name of FR102)
        for (const labels of MetricsRegistry.labelSets(name)) {
          for (const [k, v] of Object.entries(labels)) {
            expect([name, k, allowedKeys.has(k)]).toEqual([name, k, true]);
            expect(String(v)).toMatch(/^[a-z0-9_]{1,40}$/);
          }
        }
    });

    it('S08 AS-78: every log call of the capability is a structured object with an action and the integration it concerns, never a formatted string', () => {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (statSync(path).isDirectory()) {
            if (entry !== 'test') walk(path);
          } else if (path.endsWith('.ts') && !/\.(e2e-)?spec\.ts$/.test(path)) {
            const text = readFileSync(path, 'utf8');
            const calls = text.matchAll(
              /logger\.(?:log|warn|error|debug|verbose)\(\s*([`'"])/g,
            );
            for (const m of calls)
              offenders.push(
                `${path.replace(__dirname, '')}:${text.slice(0, m.index).split('\n').length}`,
              );
          }
        }
      };
      walk(__dirname);
      expect(offenders).toEqual([]);
    });

    it('S08 AS-78: logs, metric labels and outbox payloads of the lifecycle flows hold no token, secret, ciphertext or raw provider payload', async () => {
      const lines: unknown[][] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation((...args: unknown[]) => {
              lines.push(args);
            }),
      );
      try {
        const a = await world();
        const b = await world();
        a.fake.addProduct({ title: 'A secret title', stock: 1 });
        await engine.handle(msg(a.id, 'backfill'));
        await offboarding.project([startedEvent(a.shopId)]);
        await offboarding.project([cancelledEvent(a.shopId)]);
        const sealedA = (await rowOf(a.id)).credentialsSealed as string;
        await db.query(
          `UPDATE "Integration" SET "credentialsSealed" = :s WHERE "id" = :id`,
          {
            replacements: {
              s: (await rowOf(b.id)).credentialsSealed,
              id: a.id,
            },
          },
        );
        await engine.handle(msg(a.id, 'incremental'));
        await retention.run();

        const secrets = [
          a.fake.accessToken,
          b.fake.accessToken,
          sealedA,
          (await rowOf(b.id)).credentialsSealed,
          'A secret title',
        ];
        const logged = JSON.stringify(lines);
        const events = JSON.stringify([
          ...(await outboxOf(a.id)),
          ...(await outboxOf(b.id)),
        ]);
        const labels = JSON.stringify(
          FR102.flatMap((n) => MetricsRegistry.labelSets(n)),
        );
        for (const secret of secrets)
          for (const [where, text] of [
            ['logs', logged],
            ['outbox', events],
            ['labels', labels],
          ] as const)
            expect([where, text.includes(secret)]).toEqual([where, false]);
        for (const line of lines)
          if (
            typeof line[0] === 'object' &&
            line[0] !== null &&
            'action' in line[0]
          ) {
            const entry = line[0] as Record<string, unknown>;
            expect(String(entry.action)).toMatch(/^catalog-sync\./);
          }
        // The lifecycle lines name the integration and the shop.
        const lifecycleLines = lines.filter(
          (l) =>
            typeof l[0] === 'object' &&
            /offboarding|credentials_unreadable|needs_reauth/.test(
              String((l[0] as any)?.action),
            ),
        );
        expect(lifecycleLines.length).toBeGreaterThanOrEqual(3);
        for (const [entry] of lifecycleLines)
          expect(entry).toMatchObject({
            integrationId: expect.any(String),
            shopId: expect.any(String),
          });
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });

  // ---- AS-79 ---------------------------------------------------------------------------------------------------

  describe('secrets (AS-79)', () => {
    it('S08 AS-79: a scan of the capability tables, the outbox and the history finds no plaintext token or secret', async () => {
      const w = await world();
      w.fake.addProduct({ title: 'A', stock: 1 });
      await engine.handle(msg(w.id, 'backfill'));
      await pauseBySeller(w.id);
      await offboarding.project([startedEvent(w.shopId)]);
      const sealed = (await rowOf(w.id)).credentialsSealed as string;
      expect(sealed).toMatch(/^v2\./);
      expect(sealed).not.toContain(w.fake.accessToken);

      const dump: string[] = [];
      for (const table of [
        'Integration',
        'IntegrationHistory',
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'StockConflict',
        'CatalogReconciliationRun',
      ])
        dump.push(
          ...(
            await db.query<{ t: string }>(
              `SELECT row_to_json(x)::text AS t FROM "${table}" x`,
              { type: QueryTypes.SELECT },
            )
          ).map((r) => r.t),
        );
      dump.push(...(await outboxOf(w.id)).map((r) => JSON.stringify(r)));
      const text = dump.join('\n');
      for (const secret of [w.fake.accessToken, w.fake.clientSecret, 'shpat_'])
        expect([secret.slice(0, 6), text.includes(secret)]).toEqual([
          secret.slice(0, 6),
          false,
        ]);
    });

    it('S08 AS-79: a ciphertext copied from one integration to another fails to open: the target needs re-authorisation, no provider call is made, the pair of events is written and only ids are logged', async () => {
      const x = await world();
      const y = await world();
      const stolen = (await rowOf(x.id)).credentialsSealed as string;
      await db.query(
        `UPDATE "Integration" SET "credentialsSealed" = :stolen WHERE "id" = :id`,
        { replacements: { stolen, id: y.id } },
      );
      expect(() => vault.open(y.id, stolen)).toThrow();
      const lines: unknown[][] = [];
      const spies = (['log', 'warn', 'error'] as const).map((l) =>
        jest
          .spyOn(Logger.prototype, l)
          .mockImplementation((...a: unknown[]) => {
            lines.push(a);
          }),
      );

      let outcome: unknown;
      try {
        outcome = await engine.handle(msg(y.id, 'incremental'));
      } finally {
        for (const s of spies) s.mockRestore();
      }

      expect(outcome).toBe('failed');
      expect(await rowOf(y.id)).toMatchObject({ status: 'NEEDS_REAUTH' });
      expect(y.fake.requests).toHaveLength(0);
      expect(x.fake.requests).toHaveLength(0);
      const types = (await outboxOf(y.id)).map((r) => r.type).sort();
      expect(types).toEqual([
        'catalogsync.integration_attention_required',
        'catalogsync.integration_status_changed',
      ]);
      const text = JSON.stringify(lines);
      expect(text).not.toContain(stolen);
      expect(text).not.toContain(x.fake.accessToken);
      for (const [entry] of lines)
        if (typeof entry === 'object' && entry !== null)
          expect(
            Object.keys(entry).filter(
              (k) =>
                ![
                  'action',
                  'integrationId',
                  'shopId',
                  'runId',
                  'reason',
                ].includes(k),
            ),
          ).toEqual([]);
      // The source integration is untouched and still works.
      x.fake.addProduct({ title: 'Works', stock: 1 });
      expect(await engine.handle(msg(x.id, 'backfill'))).toBe('completed');
    });

    it('S08 AS-79: after a master key rotation the integrations sealed under the previous key keep syncing', async () => {
      const w = await world();
      w.fake.addProduct({ title: 'Rotated', stock: 4 });
      const box = ctx.app
        .select(IntegrationsWorkerModule)
        .get(SecretBox) as unknown as { key: Buffer; previousKey?: Buffer };
      const oldKey = box.key;
      const newKey = Buffer.alloc(32, 7);
      try {
        box.previousKey = oldKey; // the rotation: new key seals, the old one still opens
        box.key = newKey;
        expect(await engine.handle(msg(w.id, 'backfill'))).toBe('completed');
        expect(await countWhere('ExternalLink', 'integrationId', [w.id])).toBe(
          1,
        );
        expect(await rowOf(w.id)).toMatchObject({ status: 'ACTIVE' });
      } finally {
        box.key = oldKey;
        box.previousKey = undefined;
      }
    });

    it('S08 AS-79: credentials are erased when the seller disconnects the integration', async () => {
      const w = await world();
      expect((await rowOf(w.id)).credentialsSealed).not.toBeNull();
      await admin.disconnect(w.shopId, w.id, w.owner.id);
      expect((await rowOf(w.id)).credentialsSealed).toBeNull();
    });
  });
});

describe('Shop lifecycle events through the event stream', () => {
  const kit = new ConsumerKit();
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  it('S08 AS-74: a duplicate offboarding delivery has one effect, and an invalid payload is dead-lettered while later events are processed', async () => {
    const s = await kit.scenario();
    const name = `catalog-sync-offboarding-${s.id}`;

    @Injectable()
    class StreamOffboarding extends TenancyOffboardingConsumer {
      readonly name: string = name;
      readonly topics: string[] = [s.topic];
    }
    const app = await s.boot([StreamOffboarding], {
      imports: [IntegrationsProjectorModule],
    });
    const db = app.get<Sequelize>(getConnectionToken(), { strict: false });
    const shopId = uuidv7();
    const integrationId = uuidv7();
    await db.query(
      `INSERT INTO "Integration" ("id","shopId","provider","externalShop","status","credentialsSealed","createdAt","updatedAt")
       VALUES (:integrationId,:shopId,'shopify',:domain,'ACTIVE','v2.x.y.z',now(),now())`,
      {
        replacements: {
          integrationId,
          shopId,
          domain: `stream-${s.id}.myshopify.com`,
        },
      },
    );
    try {
      const valid = ShopOffboardingStarted.create(shopId, 3, {
        shopId,
        purgeAt: new Date().toISOString(),
        shopVersion: 3,
      });
      const invalid = {
        ...valid,
        eventId: uuidv7(),
        payload: { shopId: 'not-a-uuid', purgeAt: 1, shopVersion: 'x' },
      };
      const later = ShopOffboardingCancelled.create(shopId, 4, {
        shopId,
        shopVersion: 4,
      });
      await s.publishRaw(
        [valid, valid, invalid, later].map((e) => ({
          key: e.aggregateId,
          value: JSON.stringify(e),
        })),
      );

      await waitFor(
        async () =>
          (await readTopic(`${name}.dlq`)).length === 1 &&
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM "Outbox" WHERE "aggregateId" = :integrationId`,
              { type: QueryTypes.SELECT, replacements: { integrationId } },
            )
          )[0].n === '2',
        { description: 'one dead letter, pause and resume applied once each' },
      );
      const events = await db.query<Record<string, any>>(
        `SELECT payload->'payload'->>'reason' AS reason FROM "Outbox" WHERE "aggregateId" = :integrationId ORDER BY "createdAt","id"`,
        { type: QueryTypes.SELECT, replacements: { integrationId } },
      );
      expect(events.map((e) => e.reason)).toEqual([
        'shop_offboarding',
        'offboarding_cancelled',
      ]);
      expect(await kit.inboxRecords(name)).toBe(2); // the duplicate recorded once; the invalid one never reaches the handler
    } finally {
      await db.query(
        `DELETE FROM "Outbox" WHERE "aggregateId" = :integrationId`,
        { replacements: { integrationId } },
      );
      await db.query(
        `DELETE FROM "IntegrationHistory" WHERE "integrationId" = :integrationId`,
        { replacements: { integrationId } },
      );
      await db.query(`DELETE FROM "Integration" WHERE "id" = :integrationId`, {
        replacements: { integrationId },
      });
    }
  });

  it('S08 AS-75: a shop_deleted event with an invalid payload is dead-lettered and a valid one after it is purged', async () => {
    const s = await kit.scenario();
    const name = `catalog-sync-deleted-${s.id}`;

    @Injectable()
    class StreamDeleted extends TenancyShopDeletedConsumer {
      readonly name: string = name;
      readonly topics: string[] = [s.topic];
    }
    const app = await s.boot([StreamDeleted], {
      imports: [IntegrationsProjectorModule],
    });
    const db = app.get<Sequelize>(getConnectionToken(), { strict: false });
    const shopId = uuidv7();
    const integrationId = uuidv7();
    await db.query(
      `INSERT INTO "Integration" ("id","shopId","provider","externalShop","status","credentialsSealed","createdAt","updatedAt")
       VALUES (:integrationId,:shopId,'shopify',:domain,'ACTIVE','v2.x.y.z',now(),now())`,
      {
        replacements: {
          integrationId,
          shopId,
          domain: `stream-${s.id}.myshopify.com`,
        },
      },
    );
    try {
      const good = ShopDeleted.create(shopId, 5, { shopId, shopVersion: 5 });
      const bad = { ...good, eventId: uuidv7(), payload: { shopId: 42 } };
      await s.publishRaw(
        [bad, good].map((e) => ({
          key: e.aggregateId,
          value: JSON.stringify(e),
        })),
      );
      await waitFor(
        async () =>
          (await readTopic(`${name}.dlq`)).length === 1 &&
          (
            await db.query(
              `SELECT 1 FROM "Integration" WHERE "id" = :integrationId`,
              { type: QueryTypes.SELECT, replacements: { integrationId } },
            )
          ).length === 0,
        { description: 'one dead letter, the integration purged' },
      );
    } finally {
      await db.query(`DELETE FROM "Integration" WHERE "id" = :integrationId`, {
        replacements: { integrationId },
      });
    }
  });
});
