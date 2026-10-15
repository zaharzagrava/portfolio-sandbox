import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { Sequelize as SequelizeTs } from 'sequelize-typescript';
import { INTEGRATION_PROVIDERS } from '@marketplace-sandbox/contracts';
import {
  ProductImportService,
  ProductStockService,
} from '@app/domains/catalog';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import * as barrel from './index';
import {
  IntegrationsModule,
  IntegrationsProjectorModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import {
  CATALOG_GATEWAY,
  CREDENTIAL_VAULT,
  INTEGRATION_REPOSITORY,
  PROVIDER_SESSIONS,
  type CommerceProvider,
  type CredentialVault,
  type IntegrationRepository,
  type ProviderSessions,
} from './domain/ports';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const DOMAIN = __dirname;
const BACKEND = join(DOMAIN, '..', '..', '..');
const ROLE = 's08_catalog_sync';
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';

/** The parts of the domain that belong to other capabilities (S07 catalog import, S09 offline sync). */
const OTHER_CAPABILITIES = [
  'catalog-import.module.ts',
  'catalog-import.e2e-spec.ts',
  'sync.module.ts',
  'sync.e2e-spec.ts',
  'realtime-topics.module.ts',
  'api/catalog-import.controller.ts',
  'api/sync.controller.ts',
  'api/realtime-topics.ts',
  'api/zod.pipe.ts',
  'application/catalog-import.service.ts',
  'application/sync.service.ts',
  'infra/catalog-import.worker.ts',
  'test/data-migration.e2e-spec.ts',
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Source of the integration files only: no spec, no test double, nothing that belongs to S07 or S09. */
const integrationSources = () =>
  walk(DOMAIN)
    .map((path) => relative(DOMAIN, path))
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !/spec\.ts$/.test(file) &&
        !file.startsWith('test/') &&
        !OTHER_CAPABILITIES.includes(file),
    )
    .filter((file) => file !== 'index.ts');

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

describe('Catalog-sync integrations module boundary', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];

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
    jest.spyOn(ctx.app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await cleanup();
    await ctx.close();
  });

  async function cleanup() {
    await db.query(`DROP TRIGGER IF EXISTS s08_product_audit_trg ON "Product"`);
    await db.query(`DROP TRIGGER IF EXISTS s08_product_guard_trg ON "Product"`);
    await db.query(`DROP FUNCTION IF EXISTS s08_product_audit_fn()`);
    await db.query(`DROP FUNCTION IF EXISTS s08_product_guard_fn()`);
    await db.query(`DROP TABLE IF EXISTS s08_product_audit`);
    for (const f of fakes.splice(0)) await f.stop();
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'StockConflict',
        'IntegrationHistory',
      ])
        await db.query(
          `DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`,
          { replacements },
        );
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements,
      });
      integrationIds.length = 0;
    }
  }

  afterEach(cleanup);

  // ---- ownership -----------------------------------------------------------------------------------------------

  it('S08 AS-80: check:table-ownership --strict reports no query, model or association of another owner in any integration file', () => {
    let output = '';
    try {
      output = execFileSync('pnpm', ['check:table-ownership', '--strict'], {
        cwd: BACKEND,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Other domains still carry D-7/D-12 debt, so the strict run exits 1; only this domain's section is judged.
      output = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(output).toContain('cross-domain data accesses');
    const lines = output.split('\n');
    const start = lines.findIndex((l) => /^catalog-sync\s+\(\d+\)/.test(l));
    const findings: string[] = [];
    if (start >= 0)
      for (const line of lines.slice(start + 1)) {
        if (!line.startsWith(' ')) break;
        findings.push(line.trim());
      }
    const integrationFindings = findings.filter(
      (f) =>
        !OTHER_CAPABILITIES.some((other) =>
          f.endsWith(`libs/domains/catalog-sync/${other}`),
        ),
    );
    expect(integrationFindings).toEqual([]);
  }, 180_000);

  it('S08 AS-80: no integration file names a product, shop, membership or outbox table or model, or a catalog internal, and none opens a transaction of its own', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['product table', /"Product"/],
      ['product model', /ProductModel/],
      ['shop tables', /"Shop(?:Directory|Membership|Invite|SsoConfig)?"/],
      ['tenancy model', /ShopModel|ShopMembershipModel/],
      ['outbox table', /"Outbox"/],
      ['sequelize models', /@InjectModel|sequelize-typescript/],
      ['catalog internals', /@app\/domains\/catalog\/(?!$)/],
      ['tenancy internals', /@app\/domains\/tenancy\/(?!$)/],
      ['direct transaction', /\.transaction\(/],
      ['audit marker', /S54 T037 audit/],
      ['product_changed event', /catalog\.product_changed/],
    ];
    const hits: string[] = [];
    for (const file of integrationSources()) {
      const text = withoutComments(readFileSync(join(DOMAIN, file), 'utf8'));
      for (const [what, pattern] of forbidden)
        if (pattern.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
    expect(integrationSources().length).toBeGreaterThan(40); // the scan sees the domain, not an empty list
  });

  // ---- product writes ------------------------------------------------------------------------------------------

  it('S08 AS-80: every product row written while a store is imported, updated and stock-merged was written through the catalog commands the spy saw', async () => {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const domain = `bound-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({ shopDomain: domain, pageSize: 5 });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    const integrations = worker.get<IntegrationRepository>(
      INTEGRATION_REPOSITORY,
    );
    const vault = worker.get<CredentialVault>(CREDENTIAL_VAULT);
    const id = randomUUID();
    await integrations.insertConnected({
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
    integrationIds.push(id);
    const engine = worker.get(SyncEngineService);

    await db.query(
      `CREATE TABLE s08_product_audit (id uuid, op text, version int, "shopId" uuid)`,
    );
    await db.query(`
      CREATE FUNCTION s08_product_audit_fn() RETURNS trigger AS $$
      BEGIN INSERT INTO s08_product_audit VALUES (NEW."id", TG_OP, NEW."version", NEW."shopId"); RETURN NEW; END
      $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER s08_product_audit_trg AFTER INSERT OR UPDATE ON "Product"
      FOR EACH ROW EXECUTE FUNCTION s08_product_audit_fn()`);

    const writtenByCatalog = new Set<string>();
    let importCalls = 0;
    let stockCalls = 0;
    // The instances the domain's gateway is wired to, so the spies see exactly the domain's calls.
    const gateway = worker.get(CATALOG_GATEWAY) as unknown as {
      imports: ProductImportService;
      stock: ProductStockService;
    };
    const importSpy = jest.spyOn(gateway.imports, 'upsertFromExternal');
    const stockSpy = jest.spyOn(gateway.stock, 'applyStockDelta');
    try {
      const a = fake.addProduct({ title: 'A', stock: 5 });
      fake.addProduct({ title: 'B', stock: 6 });
      fake.addProduct({ title: 'C', stock: 7 });
      expect(await engine.handle({ integrationId: id, kind: 'backfill' })).toBe(
        'completed',
      );
      fake.updateProduct(a.id, { title: 'A v2' });
      ctx.clock.advance(60_000);
      expect(
        await engine.handle({ integrationId: id, kind: 'incremental' }),
      ).toMatch(/^completed/);
      fake.setRemoteStock(a.variants[0].id, 2);
      ctx.clock.advance(60_000);
      expect(
        await engine.handle({ integrationId: id, kind: 'incremental' }),
      ).toMatch(/^completed/);

      for (const call of importSpy.mock.results) {
        const results = (await call.value) as Array<{ productId?: string }>;
        for (const r of results)
          if (r.productId) writtenByCatalog.add(r.productId);
      }
      for (const [ops] of stockSpy.mock.calls)
        for (const op of ops as Array<{ productId: string }>)
          writtenByCatalog.add(op.productId);
      importCalls = importSpy.mock.calls.length;
      stockCalls = stockSpy.mock.calls.length;
    } finally {
      importSpy.mockRestore();
      stockSpy.mockRestore();
    }

    const audit = await db.query<{ id: string; op: string }>(
      `SELECT id, op FROM s08_product_audit WHERE "shopId" = :shopId`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId: shop.id },
      },
    );
    const written = new Set(audit.map((r) => r.id));
    expect(importCalls).toBeGreaterThanOrEqual(2);
    expect(stockCalls).toBeGreaterThanOrEqual(1);
    expect(audit.filter((r) => r.op === 'INSERT')).toHaveLength(3);
    expect(
      audit.filter((r) => r.op === 'UPDATE').length,
    ).toBeGreaterThanOrEqual(2); // title change and stock delta
    expect(written.size).toBe(3);
    expect(
      [...written].filter((productId) => !writtenByCatalog.has(productId)),
    ).toEqual([]);
    // No raw product event of this domain: the catalog's own events are the only ones for these products.
    const changed = await db.query(
      `SELECT 1 FROM "Outbox" WHERE "type" = 'catalog.product_changed' AND "aggregateId" IN (:ids)`,
      {
        type: QueryTypes.SELECT,
        replacements: { ids: [...written] },
      },
    );
    expect(changed).toHaveLength(0);
  });

  it('S08 AS-80: a trigger on the product table raises for a write by this capability’s database role and lets the catalog’s own writes through', async () => {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const productId = randomUUID();
    await db.query(
      `INSERT INTO "Product" ("id","shopId","title","description","brand","category","price","createdAt","updatedAt")
       VALUES (:productId,:shopId,'Guarded','d','b','c',100,now(),now())`,
      { replacements: { productId, shopId: shop.id } },
    );
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          CREATE ROLE "${ROLE}" LOGIN PASSWORD 'probe' NOSUPERUSER;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO "${ROLE}";
      -- Even with the privilege (the worst misconfiguration) the trigger refuses the write.
      GRANT SELECT, INSERT, UPDATE, DELETE ON "Product" TO "${ROLE}";
      GRANT SELECT, INSERT, UPDATE, DELETE ON "Integration", "ExternalLink", "SyncCursor", "SyncRun", "SyncQuarantine",
        "StockConflict", "WebhookReceipt", "CatalogReconciliationRun", "IntegrationHistory", "IntegrationInstall" TO "${ROLE}";
      CREATE FUNCTION s08_product_guard_fn() RETURNS trigger AS $$
      BEGIN
        IF current_user = '${ROLE}' THEN
          RAISE EXCEPTION 'catalog-sync must write products through the catalog services' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER s08_product_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "Product"
        FOR EACH ROW EXECUTE FUNCTION s08_product_guard_fn();`);
    const options = db.config as unknown as {
      host: string;
      port: number;
      database: string;
    };
    const asRole = new SequelizeTs({
      dialect: 'postgres',
      host: options.host,
      port: Number(options.port),
      database: options.database,
      username: ROLE,
      password: 'probe',
      logging: false,
    });
    try {
      await expect(
        asRole.query(
          `UPDATE "Product" SET "title" = 'Hacked' WHERE "id" = :productId`,
          { replacements: { productId } },
        ),
      ).rejects.toThrow(/through the catalog services/);
      await expect(
        asRole.query(`DELETE FROM "Product" WHERE "id" = :productId`, {
          replacements: { productId },
        }),
      ).rejects.toThrow(/through the catalog services/);
      await expect(
        asRole.query(
          `INSERT INTO "Product" ("id","shopId","title","description","brand","category","price","createdAt","updatedAt")
           VALUES (:id,:shopId,'Raw','d','b','c',1,now(),now())`,
          { replacements: { id: randomUUID(), shopId: shop.id } },
        ),
      ).rejects.toThrow(/through the catalog services/);
      // The role keeps its own tables.
      await asRole.query(`SELECT count(*) FROM "Integration"`);
      // The catalog's own connection is not the role: its writes pass.
      await db.query(
        `UPDATE "Product" SET "title" = 'By the catalog' WHERE "id" = :productId`,
        { replacements: { productId } },
      );
      const [row] = await db.query<{ title: string }>(
        `SELECT "title" FROM "Product" WHERE "id" = :productId`,
        { type: QueryTypes.SELECT, replacements: { productId } },
      );
      expect(row.title).toBe('By the catalog');
    } finally {
      await asRole.close();
    }
  });

  // ---- barrel and wiring ---------------------------------------------------------------------------------------

  it('S08 AS-80: the barrel exports exactly the three integration modules, plus only the unrelated exports other capabilities import', () => {
    const integrationExports = Object.keys(barrel)
      .filter((name) => /^Integration/.test(name))
      .sort();
    expect(integrationExports).toEqual([
      'IntegrationsModule',
      'IntegrationsProjectorModule',
      'IntegrationsWorkerModule',
    ]);
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'CatalogImportModule',
        'CatalogImportWorkerModule',
        'ImportJobTopicsModule',
        'IntegrationsModule',
        'IntegrationsProjectorModule',
        'IntegrationsWorkerModule',
        'OfflineSyncModule',
        'catalogSyncRatePolicies',
      ].sort(),
    );
  });

  it('S08 AS-80: the production wiring has the two real providers and no fake one, in code, contract and DI', async () => {
    const sessions = ctx.app
      .select(IntegrationsWorkerModule)
      .get<ProviderSessions & { adapters: CommerceProvider[] }>(
        PROVIDER_SESSIONS,
      );
    expect(sessions.adapters.map((p) => p.name).sort()).toEqual([
      'shopify',
      'woocommerce',
    ]);
    expect([...INTEGRATION_PROVIDERS]).toEqual(['shopify', 'woocommerce']);

    const fakeFiles = walk(DOMAIN)
      .map((p) => relative(DOMAIN, p))
      .filter((f) => /fake/i.test(f) && !f.startsWith('test/'));
    expect(fakeFiles).toEqual([]);
    const offenders = integrationSources().filter((file) =>
      /['"`]fake['"`]|FakeProvider|fake\.provider/.test(
        withoutComments(readFileSync(join(DOMAIN, file), 'utf8')),
      ),
    );
    expect(offenders).toEqual([]);
    // The one test seam of the provider stack is empty in the module the applications import.
    const wiring = readFileSync(join(DOMAIN, 'integrations.module.ts'), 'utf8');
    expect(wiring).toMatch(/provide: PROVIDER_NETWORK, useValue: \{\}/);
    expect(wiring).not.toMatch(/test\/fakes|FakeShopify|FakeWoo/);
  });

  it('S08 AS-80 / FR-003: the old integration scenarios AS-47, AS-16, AS-36, AS-26 and AS-62 live in the new files and the old file is gone', () => {
    // The first-generation spec (fake provider, IntegrationSyncService) is gone; the path survives only as the small
    // route-mounting spec the integrity gate requires (gaps.md, Gate repairs).
    const legacy = join(DOMAIN, 'integrations.e2e-spec.ts');
    if (existsSync(legacy))
      expect(withoutComments(readFileSync(legacy, 'utf8'))).not.toMatch(
        /FakeProvider|IntegrationSyncService|syncIncremental|ShopModel|"Product"/,
      );
    const specs = walk(DOMAIN).filter(
      (f) => f.endsWith('.e2e-spec.ts') && f !== __filename,
    );
    const text = specs.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const id of [47, 16, 36, 26, 62])
      expect([id, new RegExp(`['"\`]S08 AS-${id}:`).test(text)]).toEqual([
        id,
        true,
      ]);
  });

  // The applications' own wiring (which app hosts which module, the monolith) is proven beside the applications:
  // apps/local-monolith/src/integrations-wiring.e2e-spec.ts (libs may not import apps, constitution X.1).
});
