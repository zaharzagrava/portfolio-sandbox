import { QueryTypes, Sequelize } from 'sequelize';
import { v4 } from 'uuid';
import { SecretBox } from '@app/domains/identity';
import {
  firstVariantId,
  migrateIntegrationsData,
} from '../../../../scripts/catalog-sync/migrate-integrations-data';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require('../../../../configs/db.config.js').test;

const boxWith = (kek: string, previous?: string) =>
  new SecretBox({
    get: (k: string) =>
      ({ auth_kek: kek, auth_kek_previous: previous, node_env: 'test' })[k],
  } as never);
const key = (seed: string) => Buffer.alloc(32, seed).toString('base64');

/** T009: the S08 data script rewrites old-shape rows once and is a no-op on a second run. */
describe('catalog-sync data migration script (e2e)', () => {
  let db: Sequelize;
  const created: string[] = [];

  beforeAll(() => {
    db = new Sequelize({ ...dbConfig, logging: false });
  });
  afterAll(async () => {
    await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
      replacements: { ids: created.length ? created : [v4()] },
    });
    await db.close();
  });

  const seedIntegration = async (
    status: string,
    sealed: string | null,
    externalShop = `s-${v4()}.example`,
  ) => {
    const id = v4();
    created.push(id);
    await db.query(
      `INSERT INTO "Integration" ("id", "shopId", "provider", "externalShop", "credentialsSealed", "status")
       VALUES (:id, :shopId, 'shopify', :externalShop, :sealed, :status)`,
      { replacements: { id, shopId: v4(), externalShop, sealed, status } },
    );
    return id;
  };
  const seedLink = (integrationId: string, externalId: string, raw: unknown) =>
    db.query(
      `INSERT INTO "ExternalLink" ("integrationId", "entity", "externalId", "localId", "raw")
       VALUES (:integrationId, 'product', :externalId, :localId, CAST(:raw AS jsonb))`,
      {
        replacements: {
          integrationId,
          externalId,
          localId: v4(),
          raw: JSON.stringify(raw),
        },
      },
    );

  it('computes the first variant id', () => {
    expect(firstVariantId({ variants: [{ id: 77 }, { id: 78 }] }, '5')).toBe(
      '77',
    );
    expect(firstVariantId({ variations: [91] }, '5')).toBe('91');
    expect(firstVariantId({}, '5')).toBe('5');
  });

  it('migrates old-shape rows and a second run changes nothing', async () => {
    const current = boxWith(key('a'));
    const old = boxWith(key('b'));
    const reauth = await seedIntegration('ERROR', null);
    const withV1 = await seedIntegration(
      'ACTIVE',
      current.seal('{"token":"t1"}'),
    );
    const withPrevious = await seedIntegration(
      'ACTIVE',
      old.seal('{"token":"t2"}'),
    );
    await seedLink(withV1, '100', { id: 100, variants: [{ id: 555 }] });
    await seedLink(withV1, '200', { id: 200 });
    await seedLink(withV1, '300:301', { id: 300 }); // already migrated

    const sealer = boxWith(key('a'), key('b'));
    const first = await migrateIntegrationsData(db, sealer, { batchSize: 1 });
    // Other specs may leave old-shape rows in the shared test database: lower bounds here, exact zeros on re-run.
    expect(first.statusMigrated).toBeGreaterThanOrEqual(1);
    expect(first.shopIdBackfilled).toBeGreaterThanOrEqual(3);
    expect(first.linksRenamed).toBeGreaterThanOrEqual(2);
    expect(first.credentialsResealed).toBeGreaterThanOrEqual(2);

    const [status] = await db.query<{ status: string }>(
      `SELECT "status" FROM "Integration" WHERE "id" = :id`,
      { replacements: { id: reauth }, type: QueryTypes.SELECT },
    );
    expect(status.status).toBe('NEEDS_REAUTH');
    const ids = await db.query<{ externalId: string; shopId: string | null }>(
      `SELECT "externalId", "shopId" FROM "ExternalLink" WHERE "integrationId" = :id ORDER BY 1`,
      { replacements: { id: withV1 }, type: QueryTypes.SELECT },
    );
    expect(ids.map((r) => r.externalId)).toEqual([
      '100:555',
      '200:200',
      '300:301',
    ]);
    expect(ids.every((r) => r.shopId !== null)).toBe(true);
    for (const [id, token] of [
      [withV1, 't1'],
      [withPrevious, 't2'],
    ] as const) {
      const [row] = await db.query<{ credentialsSealed: string }>(
        `SELECT "credentialsSealed" FROM "Integration" WHERE "id" = :id`,
        { replacements: { id }, type: QueryTypes.SELECT },
      );
      expect(row.credentialsSealed.startsWith('v2.')).toBe(true);
      expect(
        JSON.parse(current.open(row.credentialsSealed, `integration:${id}`))
          .token,
      ).toBe(token);
    }

    const snapshot = () =>
      db.query(
        `SELECT 'i' AS t, "id"::text AS k, "status" || coalesce("credentialsSealed", '') || "updatedAt"::text AS v
           FROM "Integration" WHERE "id" IN (:ids)
         UNION ALL
         SELECT 'l', "integrationId"::text || "externalId", coalesce("shopId"::text, '') || "updatedAt"::text
           FROM "ExternalLink" WHERE "integrationId" IN (:ids) ORDER BY 1, 2`,
        {
          replacements: { ids: [reauth, withV1, withPrevious] },
          type: QueryTypes.SELECT,
        },
      );
    const before = await snapshot();
    const [{ n: historyBefore }] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "IntegrationHistory" WHERE "integrationId" = :id`,
      { replacements: { id: reauth }, type: QueryTypes.SELECT },
    );
    const second = await migrateIntegrationsData(db, sealer, { batchSize: 1 });
    expect(second).toMatchObject({
      statusMigrated: 0,
      shopIdBackfilled: 0,
      linksRenamed: 0,
      linkRenameConflicts: 0,
      credentialsResealed: 0,
      credentialsUnreadable: 0,
    });
    expect(await snapshot()).toEqual(before);
    const [{ n: historyAfter }] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "IntegrationHistory" WHERE "integrationId" = :id`,
      { replacements: { id: reauth }, type: QueryTypes.SELECT },
    );
    expect(historyAfter).toBe(historyBefore);
  });
});
