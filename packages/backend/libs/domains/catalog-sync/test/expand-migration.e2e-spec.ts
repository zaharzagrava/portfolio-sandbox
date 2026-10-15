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
