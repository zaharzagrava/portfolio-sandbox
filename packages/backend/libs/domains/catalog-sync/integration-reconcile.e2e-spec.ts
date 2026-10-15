import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  reconciliationPageSchema,
  reconciliationReportSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { LagMonitorService } from './application/lag-monitor.service';
import { ReconcileService } from './application/reconcile.service';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import {
  CATALOG_GATEWAY,
  CREDENTIAL_VAULT,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  RECONCILIATION_REPOSITORY,
  type CatalogGateway,
  type CredentialVault,
  type IntegrationRepository,
  type ReconciliationRepository,
  type SyncMessage,
} from './domain/ports';
import { IntegrationsJobs } from './infra/integrations.jobs';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const MIN = 60_000;
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

describe('Integration reconciliation', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let engine: SyncEngineService;
  let reconcile: ReconcileService;
  let lag: LagMonitorService;
  let jobs: IntegrationsJobs;
  let integrations: IntegrationRepository;
  let reports: ReconciliationRepository;
  let vault: CredentialVault;
  let gateway: CatalogGateway;
  let enqueue: jest.SpyInstance;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    reconcile = worker.get(ReconcileService);
    lag = worker.get(LagMonitorService);
    jobs = worker.get(IntegrationsJobs);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    reports = worker.get(RECONCILIATION_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    gateway = worker.get(CATALOG_GATEWAY);
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
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
    for (const f of fakes.splice(0)) await f.stop();
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'StockConflict',
        'CatalogReconciliationRun',
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

  async function world(options: { pageSize?: number } = {}) {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const domain = `recon-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: options.pageSize ?? 50,
    });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const id = randomUUID();
    const inserted = await integrations.insertConnected({
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
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(inserted.kind).toBe('inserted');
    integrationIds.push(id);
    return { owner, shopId: shop.id, fake, id };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const ago = (min: number) => new Date(ctx.clock.now().getTime() - min * MIN);
  const backfill = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'backfill',
  });
  const extId = (p: { id: number; variants: Array<{ id: number }> }) =>
    `${p.id}:${p.variants[0].id}`;

  const runReconcile = async (id: string) =>
    reconcile.run((await integrations.findById(id))!);

  const linkRows = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "ExternalLink" WHERE "integrationId" = :integrationId ORDER BY "externalId"`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );
  const linkOf = async (integrationId: string, externalId: string) =>
    (await linkRows(integrationId)).find((l) => l.externalId === externalId);

  const productRow = async (productId: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "Product" WHERE "id" = :productId`,
        { type: QueryTypes.SELECT, replacements: { productId } },
      )
    )[0];

  const reportRows = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "CatalogReconciliationRun" WHERE "integrationId" = :integrationId ORDER BY "startedAt", "id"`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const attention = async (integrationId: string) =>
    (
      await db.query<{ reason: string }>(
        `SELECT payload->'payload'->>'reason' AS reason FROM "Outbox"
          WHERE "aggregateId" = :integrationId AND "type" = 'catalogsync.integration_attention_required'`,
        { type: QueryTypes.SELECT, replacements: { integrationId } },
      )
    ).map((r) => r.reason);

  const completedEvents = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT payload->'payload' AS body FROM "Outbox"
        WHERE "aggregateId" = :integrationId AND "type" = 'catalogsync.reconciliation_completed'`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const sentMessages = (queue: string) =>
    enqueue.mock.calls
      .filter((c) => c[0] === queue)
      .map((c) => c[1] as SyncMessage);

  async function localChange(shopId: string, productId: string, delta: number) {
    const outcome = await gateway.applyStockDelta([
      {
        operationId: `test-${randomUUID()}`,
        productId,
        shopId,
        delta,
        reason: 'sale',
      },
    ]);
    expect(outcome.kind).toBe('applied');
  }

  const stampOld = (fake: FakeShopify, productId: number, at: Date) => {
    const p = fake.getProduct(productId)!;
    p.updated_at = at.toISOString();
    for (const v of p.variants) v.updated_at = at.toISOString();
  };

  const findingKeys = (
    findings: Array<{ kind: string; externalId: string | null }>,
  ) => findings.map((f) => `${f.kind}:${f.externalId}`).sort();

  // ---- AS-61 ---------------------------------------------------------------------------------------------------

  describe('classification and fixes', () => {
    it('S08 AS-61: seeded drift gives the exact counts; the provider-only variant is queued for a normal pull, content drift goes through the inbound path, the stock drift is pushed, the deletion is handled, local quantities are read in one batch and the report is stored', async () => {
      const t = await world();
      const mk = (title: string, stock: number, minutesAgo: number) =>
        t.fake.addProduct({ title, stock, updatedAt: ago(minutesAgo) });
      mk('M1', 5, 50);
      mk('M2', 5, 50);
      const m3 = mk('M3', 5, 5);
      const gone = mk('Gone', 5, 50);
      const c1 = mk('C1', 5, 60);
      const s1 = mk('S1', 6, 50);
      expect(await engine.handle(backfill(t.id))).toBe('completed');
      expect((await linkRows(t.id)).length).toBe(6);

      // The seller side moves; the local side moves.
      t.fake.removeProduct(gone.id);
      const fresh = t.fake.addProduct({
        title: 'New at provider',
        stock: 3,
        updatedAt: ago(2),
      });
      t.fake.updateProduct(c1.id, { title: 'C1 changed at provider' });
      stampOld(t.fake, c1.id, ago(20)); // older than the watermark: an incremental pull would never see it
      const s1Link = (await linkOf(t.id, extId(s1)))!;
      await localChange(t.shopId, s1Link.localId, -2);
      const goneLink = (await linkOf(t.id, extId(gone)))!;
      expect((await linkOf(t.id, extId(m3)))!.state).toBe('ACTIVE');

      const read = jest.spyOn(gateway, 'getProducts');
      const stockOps = jest.spyOn(gateway, 'applyStockDelta');
      enqueue.mockClear();
      expect(await runReconcile(t.id)).toBe('completed');

      const [row] = await reportRows(t.id);
      expect(row.outcome).toBe('completed');
      expect(row.finishedAt).not.toBeNull();
      expect(row.counts).toEqual({
        linked: 6,
        remote: 6,
        matched: 3,
        missingAtProvider: 1,
        missingLocally: 1,
        contentDrift: 1,
        stockDrift: 1,
        autoFixed: 4,
        needsReview: 0,
      });
      expect(findingKeys(row.findings)).toEqual(
        [
          `missing_at_provider:${extId(gone)}`,
          `missing_locally:${extId(fresh)}`,
          `content_drift:${extId(c1)}`,
          `stock_drift:${extId(s1)}`,
        ].sort(),
      );
      expect(row.truncated).toBe(false);

      // Fixes. The provider-only variant is queued for a pull, not applied inline.
      expect(sentMessages(INTEGRATION_SYNC_QUEUE)).toEqual([
        { integrationId: t.id, kind: 'one', externalId: extId(fresh) },
      ]);
      expect(
        (await linkRows(t.id)).some((l) => l.externalId === extId(fresh)),
      ).toBe(false);
      // Content drift: applied through the normal inbound path (title in the catalog, digest on the link).
      const c1Link = (await linkOf(t.id, extId(c1)))!;
      expect((await productRow(c1Link.localId)).title).toBe(
        'C1 changed at provider',
      );
      // Stock drift: exactly one conditional write "set 4 expected 6".
      expect(t.fake.stockOf(s1.variants[0].id)).toBe(4);
      const writes = t.fake.stockWrites.map(
        (w) => w.body as Record<string, any>,
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        available: 4,
        change_from_quantity: 6,
      });
      expect((await linkOf(t.id, extId(s1)))!.syncedStock).toBe(4);
      // Deletion: link state, product kept and not archived, stock zeroed by one command.
      expect((await linkOf(t.id, extId(gone)))!.state).toBe(
        'DELETED_AT_PROVIDER',
      );
      const goneProduct = await productRow(goneLink.localId);
      expect(goneProduct.quantity).toBe(0);
      expect(goneProduct.status).not.toBe('ARCHIVED');
      expect(
        stockOps.mock.calls
          .flatMap((c) => c[0])
          .filter((op) => op.reason === 'sync-deleted'),
      ).toHaveLength(1);
      // Local quantities: one batch call with every link, never one call per link.
      const ids = read.mock.calls.map((c) => c[1].length);
      expect(ids[0]).toBe(6);
      expect(ids.filter((n) => n >= 6)).toHaveLength(1);

      // The report is announced once.
      const events = await completedEvents(t.id);
      expect(events).toHaveLength(1);
      expect(events[0].body).toMatchObject({
        integrationId: t.id,
        shopId: t.shopId,
        runId: row.id,
        outcome: 'completed',
      });
    });

    it('S08 AS-61: the nightly job enqueues one reconcile message on the backfill queue for each ACTIVE integration of an ACTIVE shop and none for a paused one', async () => {
      const a = await world();
      const b = await world();
      const paused = await world();
      const suspended = await world();
      await integrations.transition(paused.id, 'ACTIVE', 'PAUSED', {
        reason: 'seller',
        actorId: null,
        now: ctx.clock.now(),
        pausedReason: 'seller',
      });
      await tenancy.setShopStatus(suspended.shopId, 'SUSPENDED');
      enqueue.mockClear();

      const result = await jobs.reconcileAll();

      const ours: string[] = [a.id, b.id, paused.id, suspended.id];
      const mine = sentMessages(INTEGRATION_BACKFILL_QUEUE).filter((m) =>
        ours.includes(m.integrationId),
      );
      const byId = (x: SyncMessage, y: SyncMessage) =>
        x.integrationId.localeCompare(y.integrationId);
      expect([...mine].sort(byId)).toEqual(
        (
          [
            { integrationId: a.id, kind: 'reconcile' },
            { integrationId: b.id, kind: 'reconcile' },
          ] as SyncMessage[]
        ).sort(byId),
      );
      expect(result.enqueued).toBeGreaterThanOrEqual(2);
    });
  });

  // ---- AS-62 ---------------------------------------------------------------------------------------------------

  describe('deletion check', () => {
    it('S08 AS-62: a variant missing from the listing is confirmed by a direct read (404): link DELETED_AT_PROVIDER, one zeroing command, product not archived, a rerun applies nothing', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Stays', stock: 2, updatedAt: ago(30) });
      const gone = t.fake.addProduct({
        title: 'Gone',
        stock: 9,
        updatedAt: ago(30),
      });
      await engine.handle(backfill(t.id));
      const link = (await linkOf(t.id, extId(gone)))!;
      t.fake.removeProduct(gone.id);
      const stockOps = jest.spyOn(gateway, 'applyStockDelta');

      await runReconcile(t.id);

      expect((await linkOf(t.id, extId(gone)))!.state).toBe(
        'DELETED_AT_PROVIDER',
      );
      expect((await linkOf(t.id, extId(gone)))!.syncedStock).toBe(0);
      const product = await productRow(link.localId);
      expect(product.quantity).toBe(0);
      expect(product.status).not.toBe('ARCHIVED');
      expect(product.deletedAt ?? null).toBeNull();
      const zeroing = stockOps.mock.calls
        .flatMap((c) => c[0])
        .filter((op) => op.reason === 'sync-deleted');
      expect(zeroing).toHaveLength(1);
      expect(zeroing[0].operationId).toMatch(new RegExp(`^sync:${t.id}:`));
      expect(
        t.fake.requestsTo('GET', new RegExp(`/products/${gone.id}\\.json$`)),
      ).toHaveLength(1);
      const versionAfter = product.version;

      stockOps.mockClear();
      ctx.clock.advance(MIN);
      await runReconcile(t.id);
      expect(stockOps).not.toHaveBeenCalled();
      expect((await productRow(link.localId)).version).toBe(versionAfter);
      const second = (await reportRows(t.id)).at(-1)!;
      expect(second.counts).toMatchObject({ linked: 1, missingAtProvider: 0 });
    });

    it('S08 AS-62: a variant the listing omits but the provider still returns is reported list_inconsistent and nothing changes', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Stays', stock: 2, updatedAt: ago(30) });
      const hidden = t.fake.addProduct({
        title: 'Hidden',
        stock: 4,
        updatedAt: ago(30),
      });
      await engine.handle(backfill(t.id));
      const link = (await linkOf(t.id, extId(hidden)))!;
      // A draft is not listed as an active product, but a direct read still returns it.
      t.fake.updateProduct(hidden.id, { status: 'draft' });
      stampOld(t.fake, hidden.id, ago(20));
      const stockOps = jest.spyOn(gateway, 'applyStockDelta');

      await runReconcile(t.id);

      const [row] = await reportRows(t.id);
      expect(findingKeys(row.findings)).toContain(
        `list_inconsistent:${extId(hidden)}`,
      );
      expect(findingKeys(row.findings)).not.toContain(
        `missing_at_provider:${extId(hidden)}`,
      );
      expect(row.counts).toMatchObject({
        missingAtProvider: 0,
        listInconsistent: 1,
      });
      expect((await linkOf(t.id, extId(hidden)))!.state).toBe('ACTIVE');
      expect(stockOps).not.toHaveBeenCalled();
      expect((await productRow(link.localId)).quantity).toBe(4);
    });

    it('S08 AS-62: a variant relisted after the confirmed deletion returns to ACTIVE and its stock is merged from base 0', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Stays', stock: 2, updatedAt: ago(30) });
      const flip = t.fake.addProduct({
        title: 'Flip',
        stock: 5,
        updatedAt: ago(30),
      });
      await engine.handle(backfill(t.id));
      const link = (await linkOf(t.id, extId(flip)))!;
      const saved = JSON.parse(JSON.stringify(t.fake.getProduct(flip.id)));
      t.fake.removeProduct(flip.id);
      await runReconcile(t.id);
      expect((await linkOf(t.id, extId(flip)))!.state).toBe(
        'DELETED_AT_PROVIDER',
      );
      expect((await productRow(link.localId)).quantity).toBe(0);

      // The seller relists it with 7 on hand.
      t.fake.restoreProduct(saved);
      t.fake.setRemoteStock(flip.variants[0].id, 7);
      ctx.clock.advance(MIN);
      await runReconcile(t.id);

      const relisted = (await linkOf(t.id, extId(flip)))!;
      expect(relisted.state).toBe('ACTIVE');
      expect(relisted.syncedStock).toBe(7);
      expect((await productRow(link.localId)).quantity).toBe(7);
    });
  });

  // ---- AS-63 ---------------------------------------------------------------------------------------------------

  describe('mass-deletion guard and partial listings', () => {
    it('S08 AS-63: a listing that returns 3 of 100 links changes nothing, ends aborted_mass_delete and raises one attention event', async () => {
      const t = await world({ pageSize: 50 });
      const all = Array.from({ length: 100 }, (_, i) =>
        t.fake.addProduct({ title: `P${i}`, stock: 1, updatedAt: ago(30) }),
      );
      expect(await engine.handle(backfill(t.id))).toBe('completed');
      expect((await linkRows(t.id)).length).toBe(100);
      for (const p of all.slice(3)) t.fake.removeProduct(p.id);
      const stockOps = jest.spyOn(gateway, 'applyStockDelta');
      const upserts = jest.spyOn(gateway, 'upsertItems');
      t.fake.clearLog();

      await runReconcile(t.id);

      const [row] = await reportRows(t.id);
      expect(row.outcome).toBe('aborted_mass_delete');
      expect(row.counts).toMatchObject({
        linked: 100,
        remote: 3,
        missingAtProvider: 97,
      });
      expect((await linkRows(t.id)).every((l) => l.state === 'ACTIVE')).toBe(
        true,
      );
      expect(stockOps).not.toHaveBeenCalled();
      expect(upserts).not.toHaveBeenCalled();
      expect(t.fake.requestsTo('GET', /\/products\/\d+\.json$/)).toHaveLength(
        0,
      );
      expect(await attention(t.id)).toEqual(['reconcile_mass_delete']);
    });

    it('S08 AS-63: a listing that fails midway ends failed and nothing is deleted', async () => {
      const t = await world({ pageSize: 2 });
      const all = Array.from({ length: 6 }, (_, i) =>
        t.fake.addProduct({ title: `P${i}`, stock: 1, updatedAt: ago(30) }),
      );
      await engine.handle(backfill(t.id));
      // Three variants vanish at the provider, and the second page of the listing breaks: a naive set difference
      // over what was read so far would delete them.
      for (const p of all.slice(2, 5)) t.fake.removeProduct(p.id);
      t.fake.inject({
        match: (r) => r.path.endsWith('/products.json') && !!r.query.page_info,
        fault: { kind: 'status', status: 500 },
      });
      const stockOps = jest.spyOn(gateway, 'applyStockDelta');

      await runReconcile(t.id);

      const [row] = await reportRows(t.id);
      expect(row.outcome).toBe('failed');
      expect((await linkRows(t.id)).every((l) => l.state === 'ACTIVE')).toBe(
        true,
      );
      expect(stockOps).not.toHaveBeenCalled();
      expect(t.fake.requestsTo('GET', /\/products\/\d+\.json$/)).toHaveLength(
        0,
      );
      expect(await attention(t.id)).toEqual([]);
    });
  });

  // ---- AS-64 ---------------------------------------------------------------------------------------------------

  describe('immutable reports', () => {
    it('S08 AS-64: the store refuses to change a finished run; the next run reports earlier findings with previousRunId and their outcome; the first report stays byte-identical', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Clean', stock: 2, updatedAt: ago(40) });
      const stuck = t.fake.addProduct({
        title: 'Stuck',
        stock: 2,
        updatedAt: ago(40),
      });
      await engine.handle(backfill(t.id));
      // `stuck` drifts but its provider timestamp is older than what the link holds: the stale guard keeps it open.
      t.fake.updateProduct(stuck.id, { title: 'Stuck, changed' });
      stampOld(t.fake, stuck.id, ago(90));
      const late = t.fake.addProduct({
        title: 'Late',
        stock: 5,
        updatedAt: ago(3),
      });

      await runReconcile(t.id);
      const [first] = await reportRows(t.id);
      const snapshot = await db.query<{
        counts: string;
        findings: string;
        truncated: boolean;
        outcome: string;
      }>(
        `SELECT counts::text AS counts, findings::text AS findings, truncated, outcome FROM "CatalogReconciliationRun" WHERE "id" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: first.id } },
      );
      expect(findingKeys(first.findings)).toEqual(
        [
          `content_drift:${extId(stuck)}`,
          `missing_locally:${extId(late)}`,
        ].sort(),
      );

      // The store refuses every change of a finished run.
      await expect(
        db.query(
          `UPDATE "CatalogReconciliationRun" SET "counts" = '{}'::jsonb WHERE "id" = :id`,
          {
            replacements: { id: first.id },
          },
        ),
      ).rejects.toThrow();
      await expect(
        db.query(
          `UPDATE "CatalogReconciliationRun" SET "outcome" = 'failed' WHERE "id" = :id`,
          {
            replacements: { id: first.id },
          },
        ),
      ).rejects.toThrow();
      expect(
        await reports.finish(
          first.id,
          { outcome: 'failed', counts: {}, findings: [] },
          ctx.clock.now(),
        ),
      ).toBe(false);

      // `late` gets pulled by the queued message; `stuck` stays open.
      const message = sentMessages(INTEGRATION_SYNC_QUEUE)[0];
      expect(message).toMatchObject({ kind: 'one', externalId: extId(late) });
      expect(await engine.handle(message)).toBe('completed');
      ctx.clock.advance(MIN);
      await runReconcile(t.id);

      const rows = await reportRows(t.id);
      expect(rows).toHaveLength(2);
      const second = rows[1];
      expect(second.previousRunId).toBe(first.id);
      const byKey = Object.fromEntries(
        second.findings.map((f: any) => [`${f.kind}:${f.externalId}`, f]),
      );
      expect(byKey[`content_drift:${extId(stuck)}`]).toMatchObject({
        previousRunId: first.id,
        outcome: 'still_open',
      });
      expect(byKey[`missing_locally:${extId(late)}`]).toMatchObject({
        previousRunId: first.id,
        outcome: 'fixed',
      });
      expect(second.counts).toMatchObject({
        contentDrift: 1,
        missingLocally: 0,
      });

      const after = await db.query<(typeof snapshot)[number]>(
        `SELECT counts::text AS counts, findings::text AS findings, truncated, outcome FROM "CatalogReconciliationRun" WHERE "id" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: first.id } },
      );
      expect(after).toEqual(snapshot);
      expect(
        reconciliationReportSchema.safeParse({
          ...rows[1],
          id: rows[1].id,
          startedAt: rows[1].startedAt.toISOString(),
          finishedAt: rows[1].finishedAt.toISOString(),
        }).success,
      ).toBe(true);
    });
  });

  // ---- AS-65 ---------------------------------------------------------------------------------------------------

  describe('report routes', () => {
    const base = (t: { shopId: string; id: string }) =>
      `/api/shops/${t.shopId}/integrations/${t.id}`;

    it('S08 AS-65: the list pages with a cursor, the detail has the findings and the truncation flag, and another shop gets 404 identical to a missing id', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Only', stock: 1, updatedAt: ago(30) });
      await engine.handle(backfill(t.id));
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ctx.clock.advance(MIN);
        await runReconcile(t.id);
      }
      const big = await reports.start(t.id, ctx.clock.now(), null);
      await reports.finish(
        big,
        {
          outcome: 'completed',
          counts: { linked: 1 },
          findings: Array.from({ length: 1_001 }, (_, i) => ({
            kind: 'missing_locally',
            externalId: `x:${i}`,
          })),
        },
        ctx.clock.now(),
      );

      const first = await ctx
        .as(t.owner)
        .get(`${base(t)}/reconciliations?limit=3`);
      expect(first.status).toBe(200);
      const page1 = reconciliationPageSchema.parse(first.body);
      expect(page1.items).toHaveLength(3);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.items.every((i) => (i as any).findings === undefined)).toBe(
        true,
      );
      const second = await ctx
        .as(t.owner)
        .get(
          `${base(t)}/reconciliations?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        );
      const page2 = reconciliationPageSchema.parse(second.body);
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      ids.push(
        ...page1.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
      );
      expect(new Set(ids).size).toBe(4);
      expect(ids[0]).toBe(big); // newest first

      const detail = await ctx
        .as(t.owner)
        .get(`${base(t)}/reconciliations/${big}`);
      expect(detail.status).toBe(200);
      const report = reconciliationReportSchema.parse(detail.body);
      expect(report.findings).toHaveLength(1_000);
      expect(report.truncated).toBe(true);
      const plain = reconciliationReportSchema.parse(
        (await ctx.as(t.owner).get(`${base(t)}/reconciliations/${ids[1]}`))
          .body,
      );
      expect(plain.truncated).toBe(false);
      expect(plain.outcome).toBe('completed');

      expect(
        (await ctx.as(t.owner).get(`${base(t)}/reconciliations?limit=0`))
          .status,
      ).toBe(400);
      expect(
        (
          await ctx
            .as(t.owner)
            .get(`${base(t)}/reconciliations/${randomUUID()}`)
        ).status,
      ).toBe(404);

      // Another shop's owner asks through their own path with these ids.
      const other = await world();
      const crossList = await ctx
        .as(other.owner)
        .get(`/api/shops/${other.shopId}/integrations/${t.id}/reconciliations`);
      const crossDetail = await ctx
        .as(other.owner)
        .get(
          `/api/shops/${other.shopId}/integrations/${t.id}/reconciliations/${big}`,
        );
      const missing = await ctx
        .as(other.owner)
        .get(
          `/api/shops/${other.shopId}/integrations/${randomUUID()}/reconciliations`,
        );
      const missingRun = await ctx
        .as(other.owner)
        .get(
          `/api/shops/${other.shopId}/integrations/${other.id}/reconciliations/${randomUUID()}`,
        );
      const missingBoth = await ctx
        .as(other.owner)
        .get(
          `/api/shops/${other.shopId}/integrations/${randomUUID()}/reconciliations/${randomUUID()}`,
        );
      for (const res of [crossList, crossDetail, missingBoth])
        expect(res.status).toBe(404);
      const shape = (b: any) => ({
        code: b.code,
        title: b.title,
        status: b.status,
        detail: b.detail,
      });
      expect(shape(crossDetail.body)).toEqual(shape(missingBoth.body));
      expect(shape(crossList.body)).toEqual(shape(missing.body));
      expect(shape(crossDetail.body)).toEqual(shape(missingRun.body));
    });

    it('S08 AS-65: an on-demand run answers 202 and queues one reconcile message; a second within the hour is 429 with Retry-After; paused and disconnected integrations are 409', async () => {
      const t = await world();
      enqueue.mockClear();
      const res = await ctx.as(t.owner).post(`${base(t)}/reconcile`);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect(sentMessages(INTEGRATION_BACKFILL_QUEUE)).toEqual([
        { integrationId: t.id, kind: 'reconcile' },
      ]);

      const again = await ctx.as(t.owner).post(`${base(t)}/reconcile`);
      expect(again.status).toBe(429);
      expect(again.headers['retry-after']).toBeDefined();
      expect(again.body.code).toBe('rate_limited');
      expect(sentMessages(INTEGRATION_BACKFILL_QUEUE)).toHaveLength(1);

      const paused = await world();
      await integrations.transition(paused.id, 'ACTIVE', 'PAUSED', {
        reason: 'seller',
        actorId: null,
        now: ctx.clock.now(),
        pausedReason: 'seller',
      });
      const pausedRes = await ctx
        .as(paused.owner)
        .post(`${base(paused)}/reconcile`);
      expect(pausedRes.status).toBe(409);
      expect(pausedRes.body.code).toBe('invalid_integration_transition');

      const gone = await world();
      await integrations.transition(gone.id, 'ACTIVE', 'DISCONNECTED', {
        reason: 'disconnected',
        actorId: null,
        now: ctx.clock.now(),
        eraseCredentials: true,
      });
      expect(
        (await ctx.as(gone.owner).post(`${base(gone)}/reconcile`)).status,
      ).toBe(409);
      // The refused calls did not use up the hour: the paused integration may reconcile once it resumes.
      await integrations.transition(paused.id, 'PAUSED', 'ACTIVE', {
        reason: 'resume',
        actorId: null,
        now: ctx.clock.now(),
      });
      expect(
        (await ctx.as(paused.owner).post(`${base(paused)}/reconcile`)).status,
      ).toBe(202);

      const other = await world();
      const cross = await ctx
        .as(other.owner)
        .post(`/api/shops/${other.shopId}/integrations/${t.id}/reconcile`);
      expect(cross.status).toBe(404);
    });
  });

  // ---- AS-66 ---------------------------------------------------------------------------------------------------

  describe('lag alert', () => {
    it('S08 AS-66: lag over 30 minutes writes one sync_lag event and sets the gauge; evaluating again writes nothing; recovery and recurrence write one new event', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Old', stock: 1, updatedAt: ago(40) });
      expect(await engine.handle(backfill(t.id))).toBe('completed');

      await lag.evaluate();
      expect(await attention(t.id)).toEqual(['sync_lag']);
      expect(
        MetricsRegistry.value('catalog_sync_lag_seconds', {
          provider: 'shopify',
        }),
      ).toBeGreaterThanOrEqual(40 * 60);

      await lag.evaluate();
      ctx.clock.advance(MIN);
      await lag.evaluate();
      expect(await attention(t.id)).toEqual(['sync_lag']);

      // A pull succeeds: the watermark moves to now, the lag is below 30 minutes, nothing is written.
      t.fake.addProduct({
        title: 'Fresh',
        stock: 1,
        updatedAt: ctx.clock.now(),
      });
      expect(
        await engine.handle({ integrationId: t.id, kind: 'incremental' }),
      ).toBe('completed');
      await lag.evaluate();
      expect(await attention(t.id)).toEqual(['sync_lag']);

      // The lag recurs: one new event.
      ctx.clock.advance(31 * MIN);
      await lag.evaluate();
      await lag.evaluate();
      expect(await attention(t.id)).toEqual(['sync_lag', 'sync_lag']);
    });

    it('S08 AS-66: an integration inside the 30 minute limit raises nothing', async () => {
      const t = await world();
      t.fake.addProduct({ title: 'Recent', stock: 1, updatedAt: ago(10) });
      await engine.handle(backfill(t.id));
      await lag.evaluate();
      expect(await attention(t.id)).toEqual([]);
    });
  });
});
