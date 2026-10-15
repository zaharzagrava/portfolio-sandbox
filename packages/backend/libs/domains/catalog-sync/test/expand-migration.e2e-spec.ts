import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require('../../../../configs/db.config.js').test;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require('../../../../migrations/20261015200000-catalog-sync-integrations-expand.js');

/** T008: the expand migration's constraints, partial uniques and the finished-run trigger, probed with raw SQL. */
describe('catalog-sync expand migration (e2e)', () => {
  let db: Sequelize;
  const integrations: string[] = [];

  beforeAll(() => {
    db = new Sequelize({ ...dbConfig, logging: false });
  });
  afterAll(async () => {
    if (integrations.length)
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements: { ids: integrations },
      });
    await db.close();
  });

  const integration = async (status = 'ACTIVE', externalShop = `s-${v4()}`) => {
    const id = v4();
    integrations.push(id);
    await db.query(
      `INSERT INTO "Integration" ("id", "shopId", "provider", "externalShop", "status")
       VALUES (:id, :shopId, 'shopify', :externalShop, :status)`,
      { replacements: { id, shopId: v4(), externalShop, status } },
    );
    return { id, externalShop };
  };

  it('can run twice (idempotent)', async () => {
    await expect(migration.up(db.getQueryInterface())).resolves.toBeUndefined();
  });

  it('keeps one live integration per (provider, externalShop), a disconnected one frees it', async () => {
    const a = await integration();
    await expect(integration('ACTIVE', a.externalShop)).rejects.toThrow();
    await db.query(
      `UPDATE "Integration" SET "status" = 'DISCONNECTED' WHERE "id" = :id`,
      {
        replacements: { id: a.id },
      },
    );
    await expect(integration('ACTIVE', a.externalShop)).resolves.toBeDefined();
  });

  it('widens status and guards pausedReason; no foreign key to Shop', async () => {
    await expect(integration('NEEDS_REAUTH')).resolves.toBeDefined(); // random shopId: the FK is gone
    await expect(integration('BOGUS')).rejects.toThrow();
    const { id } = await integration();
    await expect(
      db.query(
        `UPDATE "Integration" SET "pausedReason" = 'seller' WHERE "id" = :id`,
        { replacements: { id } },
      ),
    ).rejects.toThrow(); // not PAUSED
    await db.query(
      `UPDATE "Integration" SET "status" = 'PAUSED', "pausedReason" = 'seller' WHERE "id" = :id`,
      {
        replacements: { id },
      },
    );
  });

  it('allows one OPEN quarantine per dedupe key and one OPEN conflict per (base, local, remote)', async () => {
    const { id } = await integration();
    const quarantine = (status: string) =>
      db.query(
        `INSERT INTO "SyncQuarantine" ("integrationId", "entity", "dedupeKey", "reasonCode", "status")
         VALUES (:id, 'product', 'k1', 'bad', :status)`,
        { replacements: { id, status } },
      );
    await quarantine('OPEN');
    await expect(quarantine('OPEN')).rejects.toThrow();
    await expect(quarantine('DISMISSED')).resolves.toBeDefined();

    const conflict = (status: string) =>
      db.query(
        `INSERT INTO "StockConflict" ("integrationId", "shopId", "externalId", "kind", "base", "local", "remote", "status")
         VALUES (:id, :shop, 'e1', 'oversold', 5, 3, 4, :status)`,
        { replacements: { id, shop: v4(), status } },
      );
    await conflict('OPEN');
    await expect(conflict('OPEN')).rejects.toThrow();
    await expect(conflict('DISMISSED')).resolves.toBeDefined();
  });

  it('refuses updates to a finished reconciliation run but allows deleting it', async () => {
    const integrationId = v4();
    const [{ id: open }] = await db.query<{ id: string }>(
      `INSERT INTO "CatalogReconciliationRun" ("integrationId") VALUES (:integrationId) RETURNING "id"`,
      { replacements: { integrationId }, type: QueryTypes.SELECT },
    );
    await db.query(
      `UPDATE "CatalogReconciliationRun" SET "outcome" = 'completed', "finishedAt" = now() WHERE "id" = :open`,
      { replacements: { open } },
    ); // an unfinished run may be finished once
    await expect(
      db.query(
        `UPDATE "CatalogReconciliationRun" SET "truncated" = true WHERE "id" = :open`,
        { replacements: { open } },
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(
        `UPDATE "CatalogReconciliationRun" SET "outcome" = 'bogus' WHERE "id" = :open`,
        { replacements: { open } },
      ),
    ).rejects.toThrow();
    await db.query(
      `DELETE FROM "CatalogReconciliationRun" WHERE "id" = :open`,
      { replacements: { open } },
    );
  });

  it('bounds the installation state, receipts and findings', async () => {
    const digest = v4();
    const install = () =>
      db.query(
        `INSERT INTO "IntegrationInstall" ("shopId", "userId", "shopDomain", "stateDigest") VALUES (:s, :u, 'a.myshopify.com', :digest)`,
        { replacements: { s: v4(), u: v4(), digest } },
      );
    await install();
    await expect(install()).rejects.toThrow();
    await db.query(
      `DELETE FROM "IntegrationInstall" WHERE "stateDigest" = :digest`,
      { replacements: { digest } },
    );
    const integrationId = v4();
    const receipt = () =>
      db.query(
        `INSERT INTO "WebhookReceipt" ("integrationId", "deliveryId") VALUES (:integrationId, 'd1')`,
        {
          replacements: { integrationId },
        },
      );
    await receipt();
    await expect(receipt()).rejects.toThrow();
    await db.query(
      `DELETE FROM "WebhookReceipt" WHERE "integrationId" = :integrationId`,
      { replacements: { integrationId } },
    );
    await expect(
      db.query(
        `INSERT INTO "CatalogReconciliationRun" ("integrationId", "findings")
         VALUES (:integrationId, (SELECT jsonb_agg(i) FROM generate_series(1, 1001) i))`,
        { replacements: { integrationId } },
      ),
    ).rejects.toThrow();
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const legacy = require('../../../../migrations/20261001360000-offline-sync.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const offlineExpand = require('../../../../migrations/20261015300000-offline-sync-expand.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const offlineContract = require('../../../../migrations/20261015300100-offline-sync-contract.js');

/**
 * S09 T016 / T048: the offline sync migrations, run in a scratch schema that holds the legacy tables (so populated
 * legacy rows can be migrated without touching the shared tables), and the shared tables' final shape (AS-53).
 */
describe('Offline sync migrations (e2e)', () => {
  let db: Sequelize;
  const schemas: string[] = [];

  beforeAll(() => {
    // One connection, so `search_path` set once applies to every statement of a migration.
    db = new Sequelize({ ...dbConfig, logging: false, pool: { max: 1 } });
  });
  afterAll(async () => {
    await db.query(`SET search_path TO public`);
    for (const schema of schemas)
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  });

  /** A scratch schema with the product table the legacy migration hangs its trigger and foreign key on. */
  async function scratch() {
    const schema = `s09_mig_${v4().replace(/-/g, '').slice(0, 12)}`;
    schemas.push(schema);
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await db.query(
      `CREATE TABLE "Product" (id uuid PRIMARY KEY, "shopId" uuid NULL, quantity int NOT NULL DEFAULT 0,
         title text NOT NULL DEFAULT '', price int NOT NULL DEFAULT 0, description text NOT NULL DEFAULT '',
         version int NOT NULL DEFAULT 1)`,
    );
    await legacy.up(db.getQueryInterface());
    return schema;
  }

  const product = async (shopId: string | null) => {
    const id = v4();
    await db.query(
      `INSERT INTO "Product" (id, "shopId", title) VALUES (:id, :shopId, 'p')`,
      { replacements: { id, shopId } },
    );
    return id;
  };

  it('S09 AS-53: the expand step keeps populated legacy rows, renames price clocks and drops clocks with no shop', async () => {
    await scratch();
    const shop = v4();
    const withShop = await product(shop);
    const noShop = await product(null);
    const [done, conflict, pending] = [v4(), v4(), v4()];
    for (const [opId, result] of [
      [done, 'applied'],
      [conflict, 'conflict'],
      [pending, 'pending'],
    ])
      await db.query(
        `INSERT INTO "SyncOperation" ("opId", "shopId", "deviceId", "type", "hlc", "result", "detail")
         VALUES (:opId, :shop, 'dev-a', 'stock.adjust', '000000000001000-00000-dev-a', :result, '{"reason":"oversold"}')`,
        { replacements: { opId, shop, result } },
      );
    await db.query(
      `INSERT INTO "ProductFieldClock" ("productId", "field", "hlc") VALUES
         (:withShop, 'price', '000000000001000-00000-dev-a'), (:withShop, 'title', '000000000002000-00000-dev-a'),
         (:noShop, 'title', '000000000001000-00000-dev-a')`,
      { replacements: { withShop, noShop } },
    );

    await offlineExpand.up(db.getQueryInterface());

    const ops = await db.query<{
      opId: string;
      status: string;
      result: string | null;
      claimedAt: Date | null;
      completedAt: Date | null;
    }>(
      `SELECT "opId", "status", "result", "claimedAt", "completedAt" FROM "SyncOperation" WHERE "shopId" = :shop`,
      { replacements: { shop }, type: QueryTypes.SELECT },
    );
    const byId = new Map(ops.map((o) => [o.opId, o]));
    expect(byId.get(done)?.status).toBe('applied');
    expect(byId.get(conflict)?.status).toBe('conflict');
    expect(byId.get(pending)?.status).toBe('pending');
    expect(byId.get(done)?.completedAt).not.toBeNull();
    expect(byId.get(pending)?.completedAt).toBeNull();
    expect(byId.get(pending)?.claimedAt).not.toBeNull();

    const clocks = await db.query<{
      productId: string;
      field: string;
      shopId: string;
    }>(
      `SELECT "productId", "field", "shopId" FROM "ProductFieldClock" ORDER BY "field"`,
      { type: QueryTypes.SELECT },
    );
    expect(clocks.map((c) => c.field)).toEqual(['priceMinor', 'title']);
    expect(
      clocks.every((c) => c.shopId === shop && c.productId === withShop),
    ).toBe(true);

    // The key of an operation is now (shopId, opId): the same pair twice is refused.
    await expect(
      db.query(
        `INSERT INTO "SyncOperation" ("opId", "shopId", "deviceId", "type", "hlc", "status") VALUES (:opId, :shop, 'd', 'stock.adjust', 'h', 'pending')`,
        { replacements: { opId: done, shop } },
      ),
    ).rejects.toThrow();
  });

  it('S09 AS-53: the expand step can run twice and leaves the data as it was', async () => {
    await scratch();
    const shop = v4();
    const opId = v4();
    await db.query(
      `INSERT INTO "SyncOperation" ("opId", "shopId", "deviceId", "type", "hlc", "result") VALUES (:opId, :shop, 'd', 'stock.adjust', 'h', 'applied')`,
      { replacements: { opId, shop } },
    );
    await offlineExpand.up(db.getQueryInterface());
    const snapshot = () =>
      db.query(`SELECT * FROM "SyncOperation" ORDER BY "opId"`, {
        type: QueryTypes.SELECT,
      });
    const before = await snapshot();
    await expect(
      offlineExpand.up(db.getQueryInterface()),
    ).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('S09 AS-53: a fresh database migrates both steps, and the contract step is repeatable', async () => {
    await scratch();
    await offlineExpand.up(db.getQueryInterface());
    await offlineContract.up(db.getQueryInterface());
    await expect(
      offlineContract.up(db.getQueryInterface()),
    ).resolves.toBeUndefined();

    const triggers = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'product_change_log_trg' AND NOT tgisinternal AND tgrelid = '"Product"'::regclass`,
      { type: QueryTypes.SELECT },
    );
    expect(triggers).toEqual([]);
    const functions = await db.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'product_change_log' AND pronamespace = current_schema()::regnamespace`,
      { type: QueryTypes.SELECT },
    );
    expect(functions).toEqual([]);
    const foreignKeys = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = '"ProductFieldClock"'::regclass AND contype = 'f'`,
      { type: QueryTypes.SELECT },
    );
    expect(foreignKeys).toEqual([]);
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'SyncOperation'`,
      { type: QueryTypes.SELECT },
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('result');
    expect(names).not.toContain('appliedAt');
    expect(names).toEqual(
      expect.arrayContaining(['fingerprint', 'content', 'status', 'claimedAt']),
    );

    // Another shop may now use the same operation id; the same shop may not.
    const [a, b, opId] = [v4(), v4(), v4()];
    const insert = (shop: string) =>
      db.query(
        `INSERT INTO "SyncOperation" ("opId", "shopId", "deviceId", "type", "hlc", "status") VALUES (:opId, :shop, 'd', 'stock.adjust', 'h', 'pending')`,
        { replacements: { opId, shop } },
      );
    await insert(a);
    await expect(insert(b)).resolves.toBeDefined();
    await expect(insert(a)).rejects.toThrow();

    // No clock refers to a product table any more: a clock of an unknown product is accepted.
    await expect(
      db.query(
        `INSERT INTO "ProductFieldClock" ("shopId", "productId", "field", "hlc") VALUES (:a, :p, 'title', 'h')`,
        { replacements: { a, p: v4() } },
      ),
    ).resolves.toBeDefined();
    // A conflict is unique per operation and a feed entry per product version.
    await db.query(
      `INSERT INTO "SyncConflict" ("shopId", "opId", "deviceId", "productId", "kind", "requested", "applied", "shortfall", "quantityAfter")
       VALUES (:a, :opId, 'd', :p, 'oversold', -1, 0, 1, 0)`,
      { replacements: { a, opId, p: v4() } },
    );
    await expect(
      db.query(
        `INSERT INTO "SyncConflict" ("shopId", "opId", "deviceId", "productId", "kind", "requested", "applied", "shortfall", "quantityAfter")
         VALUES (:a, :opId, 'd', :p, 'oversold', -1, 0, 1, 0)`,
        { replacements: { a, opId, p: v4() } },
      ),
    ).rejects.toThrow();
    const entity = v4();
    const entry = (seq: number, version: number) =>
      db.query(
        `INSERT INTO "ShopChangeLog" ("shopId", "seq", "entity", "entityId", "version", "deleted", "data")
         VALUES (:a, :seq, 'product', :entity, :version, false, '{}')`,
        { replacements: { a, seq, entity, version } },
      );
    await entry(1, 7);
    await expect(entry(2, 7)).rejects.toThrow();
  });

  it('S09 AS-53: the shared tables have no foreign key, view or trigger on a catalog table', async () => {
    await db.query(`SET search_path TO public`);
    const triggers = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'product_change_log_trg' AND NOT tgisinternal AND tgrelid = 'public."Product"'::regclass`,
      { type: QueryTypes.SELECT },
    );
    expect(triggers).toEqual([]);
    const foreignKeys = await db.query(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN
          ('SyncOperation', 'SyncConflict', 'ShopChangeLog', 'ShopSyncState', 'ProductFieldClock'))`,
      { type: QueryTypes.SELECT },
    );
    expect(foreignKeys).toEqual([]);
  });
});
