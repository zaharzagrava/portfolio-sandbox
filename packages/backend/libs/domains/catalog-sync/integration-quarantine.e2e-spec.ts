import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  quarantineItemSchema,
  quarantinePageSchema,
  quarantineRetryResponseSchema,
} from '@marketplace-sandbox/contracts';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import {
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_REPOSITORY,
  QUARANTINE_REPOSITORY,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRepository,
  type QuarantineRepository,
  type SyncMessage,
} from './domain/ports';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
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

describe('Integration quarantine', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let config: ApiConfigService;
  let engine: SyncEngineService;
  let integrations: IntegrationRepository;
  let cursors: CursorRepository;
  let quarantine: QuarantineRepository;
  let vault: CredentialVault;
  const logSpies: jest.SpyInstance[] = [];
  let enqueue: jest.SpyInstance;
  let configSpy: jest.SpyInstance | undefined;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    config = ctx.app.get(ApiConfigService);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    cursors = worker.get(CURSOR_REPOSITORY);
    quarantine = worker.get(QUARANTINE_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    setting({ integration_sync_max_pages: 40 });
    enqueue.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
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

  function setting(values: Record<string, unknown>) {
    const original = config.get.bind(config) as (k: string) => unknown;
    configSpy?.mockRestore();
    configSpy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string) =>
        key in values ? values[key] : original(key)) as never);
  }

  async function world(options: { pageSize?: number } = {}) {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const domain = `quar-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: options.pageSize ?? 2,
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
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(result.kind).toBe('inserted');
    integrationIds.push(id);
    return { shopId: shop.id, owner, fake, id };
  }

  const backfillMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'backfill',
  });
  const incrementalMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'incremental',
  });
  const ago = (min: number) => new Date(ctx.clock.now().getTime() - min * MIN);

  const runs = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncRun" WHERE "integrationId" = :integrationId ORDER BY "id"`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );

  const rowsOf = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncQuarantine" WHERE "integrationId" = :integrationId ORDER BY "firstSeenAt" DESC, "id" DESC`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const productsOf = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "Product" WHERE "shopId" = :shopId ORDER BY "externalSku"`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId },
      },
    );

  const attentionEvents = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT payload FROM "Outbox" WHERE "aggregateId" = :integrationId AND "type" = 'catalogsync.integration_attention_required'`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const base = (t: { shopId: string; id: string }) =>
    `/api/shops/${t.shopId}/integrations/${t.id}/quarantine`;

  /** Every log call of the test, as text. */
  function captureLogs(): string[] {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      logSpies.push(
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(JSON.stringify(args));
          }),
      );
    return lines;
  }

  const counter = (name: string, labels: Record<string, string>) =>
    MetricsRegistry.value(name, labels) ?? 0;

  // ---- AS-47 ---------------------------------------------------------------------------------------------------

  it('S08 AS-47: four good variants and one with price "free" import, the bad one is quarantined with its payload, the watermark moves past it, a metric moves and no log carries the payload', async () => {
    const t = await world({ pageSize: 2 });
    for (let i = 0; i < 4; i++)
      t.fake.addProduct({
        title: `Good ${i}`,
        stock: i + 1,
        updatedAt: ago(30 - i),
      });
    const marker = `PAYLOAD-MARKER-${randomUUID()}`;
    const bad = t.fake.addProduct({
      title: marker,
      price: 'free',
      stock: 2,
      updatedAt: ago(1),
    });
    const lines = captureLogs();
    const before = counter('catalog_sync_items_total', {
      provider: 'shopify',
      result: 'quarantined',
    });

    const outcome = await engine.handle(backfillMsg(t.id));

    expect(outcome).toBe('completed_with_quarantine');
    expect((await runs(t.id))[0]).toMatchObject({
      outcome: 'completed_with_quarantine',
      counters: { fetched: 5, created: 4, quarantined: 1 },
    });
    expect(await productsOf(t.shopId)).toHaveLength(4);

    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'product',
      externalId: `${bad.id}:${bad.variants[0].id}`,
      reasonCode: 'invalid_price',
      status: 'OPEN',
      occurrences: 1,
    });
    expect(rows[0].message.length).toBeLessThanOrEqual(500);
    expect(rows[0].payload).toMatchObject({ id: bad.id, title: marker });
    expect(rows[0].firstSeenAt).toEqual(rows[0].lastSeenAt);

    // The bad item is the newest: the watermark is not stuck before it.
    expect(
      (await cursors.read(t.id, 'product'))!.watermark?.toISOString(),
    ).toBe(bad.updated_at);

    expect(
      counter('catalog_sync_items_total', {
        provider: 'shopify',
        result: 'quarantined',
      }),
    ).toBe(before + 1);
    const text = lines.join('\n');
    expect(text).toContain('catalog-sync.item_quarantined');
    expect(text).toContain('invalid_price');
    expect(text).not.toContain(marker);
  });

  // ---- AS-48 ---------------------------------------------------------------------------------------------------

  it('S08 AS-48: twelve overlap re-reads of one bad item leave one OPEN row with occurrences 13; a changed bad payload updates it in place', async () => {
    const t = await world({ pageSize: 10 });
    t.fake.addProduct({ title: 'Good', stock: 1, updatedAt: ago(20) });
    const bad = t.fake.addProduct({
      title: 'Bad',
      price: 'free',
      stock: 1,
      updatedAt: ago(10),
    });
    await engine.handle(backfillMsg(t.id));
    const first = (await rowsOf(t.id))[0];

    for (let i = 0; i < 12; i++) {
      ctx.clock.advance(1000);
      expect(await engine.handle(incrementalMsg(t.id))).toBe(
        'completed_with_quarantine',
      );
    }

    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      status: 'OPEN',
      occurrences: 13,
    });
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(
      rows[0].firstSeenAt.getTime(),
    );
    expect(rows[0].firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());

    t.fake.updateProduct(bad.id, { price: 'gratis' });
    await engine.handle(incrementalMsg(t.id));
    const changed = await rowsOf(t.id);
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe(first.id);
    expect(changed[0].occurrences).toBe(14);
    expect(changed[0].payload.variants[0].price).toBe('gratis');
  });

  it('S08 AS-48: an item without a readable id is deduplicated by a digest of its payload', async () => {
    const t = await world({ pageSize: 10 });
    const odd = t.fake.addProduct({
      title: 'No id',
      stock: 1,
      updatedAt: ago(10),
    });
    t.fake.malform(odd.id, { variants: [{ title: 'broken', price: '1.00' }] });

    await engine.handle(backfillMsg(t.id));
    await engine.handle(incrementalMsg(t.id));

    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: null,
      reasonCode: 'invalid_payload',
      occurrences: 2,
    });
    expect(rows[0].payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].dedupeKey).toBe(rows[0].payloadDigest);
  });

  it('S08 AS-48: concurrent inserts of the same item leave exactly one row', async () => {
    const t = await world();
    const input = {
      integrationId: t.id,
      entity: 'product',
      externalId: '1:2',
      dedupeKey: '1:2',
      payloadDigest: 'd',
      reasonCode: 'invalid_price',
      message: 'x'.repeat(900),
      payload: { id: 1 },
    };

    await Promise.all(
      Array.from({ length: 8 }, () =>
        quarantine.record(input, ctx.clock.now()),
      ),
    );

    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(8);
    expect(rows[0].message).toHaveLength(500);
  });

  // ---- AS-49 ---------------------------------------------------------------------------------------------------

  it('S08 AS-49: an item fixed at the provider is applied by the next pull and its row becomes RESOLVED fixed_at_provider', async () => {
    const t = await world({ pageSize: 10 });
    const bad = t.fake.addProduct({
      title: 'Fixable',
      price: 'free',
      stock: 4,
      updatedAt: ago(10),
    });
    await engine.handle(backfillMsg(t.id));
    expect(await productsOf(t.shopId)).toHaveLength(0);
    expect(await rowsOf(t.id)).toHaveLength(1);

    ctx.clock.advance(MIN);
    t.fake.updateProduct(bad.id, { price: '5.00' });
    const outcome = await engine.handle(incrementalMsg(t.id));

    expect(outcome).toBe('completed');
    expect(await productsOf(t.shopId)).toHaveLength(1);
    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'RESOLVED',
      resolution: 'fixed_at_provider',
    });
    expect(rows[0].resolvedAt).not.toBeNull();
  });

  // ---- AS-50 ---------------------------------------------------------------------------------------------------

  describe('review routes', () => {
    async function withBad(count: number) {
      const t = await world({ pageSize: 10 });
      const bads: Array<ReturnType<FakeShopify['addProduct']>> = [];
      for (let i = 0; i < count; i++) {
        bads.push(
          t.fake.addProduct({
            title: `Bad ${i}`,
            price: 'free',
            stock: 1,
            updatedAt: ago(20 - i),
          }),
        );
        ctx.clock.advance(1000);
        await engine.handle(backfillMsg(t.id));
      }
      return { ...t, bads, rows: await rowsOf(t.id) };
    }

    it('S08 AS-50: lists newest first with a status filter, a limit, an opaque cursor and refuses a tampered one or a bad limit', async () => {
      const t = await withBad(3);
      expect(t.rows).toHaveLength(3);
      await db.query(
        `UPDATE "SyncQuarantine" SET "status" = 'DISMISSED', "resolution" = 'dismissed' WHERE "id" = :id`,
        {
          replacements: { id: t.rows[2].id },
        },
      );

      const first = await ctx.as(t.owner).get(`${base(t)}?status=OPEN&limit=1`);
      expect(first.status).toBe(200);
      const page1 = quarantinePageSchema.parse(first.body);
      expect(page1.items.map((i) => i.id)).toEqual([t.rows[0].id]);
      expect(page1.items[0]).toMatchObject({
        reasonCode: 'invalid_price',
        status: 'OPEN',
        occurrences: 1,
      });
      expect(page1.nextCursor).not.toBeNull();
      const second = quarantinePageSchema.parse(
        (
          await ctx
            .as(t.owner)
            .get(
              `${base(t)}?status=OPEN&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
            )
        ).body,
      );
      expect(second.items.map((i) => i.id)).toEqual([t.rows[1].id]);
      expect(second.nextCursor).toBeNull();

      const dismissed = quarantinePageSchema.parse(
        (await ctx.as(t.owner).get(`${base(t)}?status=DISMISSED`)).body,
      );
      expect(dismissed.items.map((i) => i.id)).toEqual([t.rows[2].id]);
      const all = quarantinePageSchema.parse(
        (await ctx.as(t.owner).get(base(t))).body,
      );
      expect(all.items).toHaveLength(3);

      const tampered = await ctx
        .as(t.owner)
        .get(
          `${base(t)}?limit=1&cursor=${encodeURIComponent(page1.nextCursor!.slice(0, -2) + 'xx')}`,
        );
      expect(tampered.status).toBe(400);
      expect(tampered.body.code).toBe('invalid_cursor');
      expect((await ctx.as(t.owner).get(`${base(t)}?limit=101`)).status).toBe(
        400,
      );
      expect((await ctx.as(t.owner).get(`${base(t)}?limit=0`)).status).toBe(
        400,
      );
    });

    it('S08 AS-50: retry applies an item fixed at the provider (resolved) and increments occurrences of one that is still invalid', async () => {
      const t = await withBad(2);
      const fixed = t.bads[0];
      const rowFixed = t.rows.find(
        (r) => r.externalId === `${fixed.id}:${fixed.variants[0].id}`,
      )!;
      const rowStill = t.rows.find((r) => r.id !== rowFixed.id)!;
      t.fake.updateProduct(fixed.id, { price: '7.50' });

      const resolved = await ctx
        .as(t.owner)
        .post(`${base(t)}/${rowFixed.id}/retry`);
      expect(resolved.status).toBe(200);
      const body = quarantineRetryResponseSchema.parse(resolved.body);
      expect(body.outcome).toBe('resolved');
      expect(body.item).toMatchObject({
        id: rowFixed.id,
        status: 'RESOLVED',
        resolution: 'fixed_at_provider',
      });
      expect(await productsOf(t.shopId)).toHaveLength(1);

      const still = await ctx
        .as(t.owner)
        .post(`${base(t)}/${rowStill.id}/retry`);
      expect(still.status).toBe(200);
      const stillBody = quarantineRetryResponseSchema.parse(still.body);
      expect(stillBody.outcome).toBe('still_invalid');
      expect(stillBody.item).toMatchObject({
        id: rowStill.id,
        status: 'OPEN',
        occurrences: 2,
      });
      expect(await productsOf(t.shopId)).toHaveLength(1);

      const again = await ctx
        .as(t.owner)
        .post(`${base(t)}/${rowFixed.id}/retry`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('quarantine_not_open');
    });

    it('S08 AS-50: dismiss closes an open row once, then answers 409 quarantine_not_open for dismiss and retry', async () => {
      const t = await withBad(1);
      const row = t.rows[0];

      const res = await ctx.as(t.owner).post(`${base(t)}/${row.id}/dismiss`);
      expect(res.status).toBe(200);
      expect(quarantineItemSchema.parse(res.body)).toMatchObject({
        id: row.id,
        status: 'DISMISSED',
        resolution: 'dismissed',
      });
      expect((await rowsOf(t.id))[0]).toMatchObject({
        status: 'DISMISSED',
        dismissedBy: t.owner.id,
      });

      for (const action of ['dismiss', 'retry']) {
        const again = await ctx
          .as(t.owner)
          .post(`${base(t)}/${row.id}/${action}`);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('quarantine_not_open');
      }
    });

    it('S08 AS-50: another shop or integration answers 404 and changes nothing', async () => {
      const t = await withBad(1);
      const other = await withBad(1);
      const foreignRow = other.rows[0];

      for (const action of ['dismiss', 'retry']) {
        const crossIntegration = await ctx
          .as(t.owner)
          .post(`${base(t)}/${foreignRow.id}/${action}`);
        expect(crossIntegration.status).toBe(404);
        expect(crossIntegration.body.code).toBe('quarantine_not_found');
        const missing = await ctx
          .as(t.owner)
          .post(`${base(t)}/${randomUUID()}/${action}`);
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe('quarantine_not_found');
      }
      const crossShop = await ctx
        .as(t.owner)
        .post(
          `/api/shops/${t.shopId}/integrations/${other.id}/quarantine/${foreignRow.id}/dismiss`,
        );
      expect(crossShop.status).toBe(404);
      const list = await ctx
        .as(t.owner)
        .get(`/api/shops/${t.shopId}/integrations/${other.id}/quarantine`);
      expect(list.status).toBe(404);
      expect(list.body.code).toBe('integration_not_found');
      expect((await rowsOf(other.id))[0]).toMatchObject({
        status: 'OPEN',
        occurrences: 1,
      });
    });

    it('S08 AS-50: two concurrent dismisses, and a concurrent dismiss and retry, leave exactly one transition', async () => {
      const t = await withBad(2);
      const [a, b] = t.rows;

      const twice = await Promise.all([
        ctx.as(t.owner).post(`${base(t)}/${a.id}/dismiss`),
        ctx.as(t.owner).post(`${base(t)}/${a.id}/dismiss`),
      ]);
      expect(twice.map((r) => r.status).sort()).toEqual([200, 409]);

      const bad = t.bads.find(
        (p) => b.externalId === `${p.id}:${p.variants[0].id}`,
      )!;
      t.fake.updateProduct(bad.id, { price: '3.00' });
      const mixed = await Promise.all([
        ctx.as(t.owner).post(`${base(t)}/${b.id}/dismiss`),
        ctx.as(t.owner).post(`${base(t)}/${b.id}/retry`),
      ]);
      expect(mixed.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = mixed.find((r) => r.status === 200)!;
      const row = (await rowsOf(t.id)).find((r) => r.id === b.id)!;
      if ('outcome' in winner.body) expect(row.status).toBe('RESOLVED');
      else expect(row.status).toBe('DISMISSED');
    });
  });

  // ---- AS-51 ---------------------------------------------------------------------------------------------------

  it('S08 AS-51: a variant the catalog refuses is quarantined catalog_rejected with the catalog field and code while the other four are applied', async () => {
    const t = await world({ pageSize: 10 });
    for (let i = 0; i < 4; i++)
      t.fake.addProduct({
        title: `Fine ${i}`,
        stock: 1,
        updatedAt: ago(10 + i),
      });
    // The catalog caps a brand at 100 characters; the provider adapter does not.
    const refused = t.fake.addProduct({
      title: 'Refused',
      vendor: 'V'.repeat(150),
      stock: 1,
      updatedAt: ago(5),
    });

    const outcome = await engine.handle(backfillMsg(t.id));

    expect(outcome).toBe('completed_with_quarantine');
    expect((await runs(t.id))[0].counters).toMatchObject({
      created: 4,
      quarantined: 1,
    });
    expect(await productsOf(t.shopId)).toHaveLength(4);
    const rows = await rowsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reasonCode: 'catalog_rejected',
      externalId: `${refused.id}:${refused.variants[0].id}`,
      status: 'OPEN',
    });
    expect(rows[0].message).toContain('brand');
    expect(rows[0].message).toContain('invalid');
  });

  // ---- AS-53 ---------------------------------------------------------------------------------------------------

  it('S08 AS-53: 1,001 malformed items halt the run at 1,000 without moving the watermark, raise one schema_drift event, delay the next pull by an hour and keep the good items', async () => {
    const t = await world({ pageSize: 250 });
    t.fake.addProduct({ title: 'Seed', stock: 1, updatedAt: ago(200) });
    expect(await engine.handle(backfillMsg(t.id))).toBe('completed');
    const watermark = (await cursors.read(t.id, 'product'))!.watermark!;

    ctx.clock.advance(MIN);
    for (let i = 0; i < 3; i++)
      t.fake.addProduct({ title: `Good ${i}`, stock: 1, updatedAt: ago(1) });
    for (let i = 0; i < 1001; i++) {
      const p = t.fake.addProduct({
        title: `Drift ${i}`,
        stock: 1,
        updatedAt: ago(1),
      });
      t.fake.malform(p.id, {
        variants: [
          {
            id: p.variants[0].id,
            title: 'x',
            price: 'oops',
            inventory_item_id: 1,
          },
        ],
      });
    }
    const now = ctx.clock.now();

    const outcome = await engine.handle(incrementalMsg(t.id));

    expect(outcome).toBe('halted_schema_drift');
    const recorded = await runs(t.id);
    expect(recorded[1]).toMatchObject({
      outcome: 'halted_schema_drift',
      counters: { quarantined: 1000 },
    });
    expect(
      (await rowsOf(t.id)).filter((r) => r.status === 'OPEN'),
    ).toHaveLength(1000);
    expect(await productsOf(t.shopId)).toHaveLength(4);
    const cursor = (await cursors.read(t.id, 'product'))!;
    expect(cursor.watermark?.toISOString()).toBe(watermark.toISOString());
    expect(cursor.pageCursor).toBeNull();

    const events = await attentionEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.payload).toMatchObject({
      integrationId: t.id,
      shopId: t.shopId,
      reason: 'schema_drift',
    });
    expect(JSON.stringify(events[0].payload)).not.toContain('oops');
    const row = await integrations.findById(t.id);
    expect(row!.nextSyncAt!.getTime()).toBe(now.getTime() + 60 * MIN);
  });
});
