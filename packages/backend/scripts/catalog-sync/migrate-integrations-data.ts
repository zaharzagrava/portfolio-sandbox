/**
 * S08 data migration (specs/domains/S08-integrations: gaps A17, A45; data-model.md "Migration order" step 2).
 * Runs AFTER `20261015200000-catalog-sync-integrations-expand.js`, by an operator, never at startup (III.11).
 *
 *   NODE_ENV=production AUTH_KEK=... [AUTH_KEK_PREVIOUS=...] DB_* ... \
 *     pnpm catalog-sync:migrate-data [--batch-size 200] [--dry-run]
 *
 * Steps (each safe to repeat; a re-run on migrated data changes nothing and reports zeros):
 *  1. `Integration.status` ERROR -> NEEDS_REAUTH (+ one IntegrationHistory row per changed integration)
 *  2. `ExternalLink.shopId` backfilled from the integration
 *  3. `ExternalLink.externalId` `<productId>` -> `<productId>:<firstVariantId>`, the variant read from `raw` (jsonb):
 *     Shopify `variants[0].id`; WooCommerce `variations[0]` (id or object); a product without variants repeats its own
 *     id (`<id>:<id>`). A target key that already exists is left alone and counted as a conflict. Other variants are
 *     created by the first backfill.
 *  4. `Integration.credentialsSealed` re-sealed with context `integration:<id>`. `v1` values (no context) are opened
 *     (current KEK, then `AUTH_KEK_PREVIOUS`) and sealed with the current KEK; a `v2` value that already opens under
 *     the context is skipped. A value that opens under neither is counted as `unreadable` and left untouched.
 *
 * Resumable: rows are processed in keyset order in small batches, one compare-and-swap UPDATE per row
 * (`WHERE ... = <value read>`), so a crash or a concurrent writer loses nothing and a restart simply continues.
 * Idempotent: every step selects only rows still in the old shape.
 */
import { QueryTypes, Sequelize } from 'sequelize';
import { SecretBox } from '@app/domains/identity';

export interface DataMigrationSealer {
  seal(plaintext: string, context?: string): string;
  open(sealed: string, context?: string): string;
}

export interface DataMigrationReport {
  statusMigrated: number;
  shopIdBackfilled: number;
  linksRenamed: number;
  linkRenameConflicts: number;
  credentialsResealed: number;
  credentialsAlreadySealed: number;
  credentialsUnreadable: number;
}

export interface DataMigrationOptions {
  batchSize?: number;
  dryRun?: boolean;
  log?: (message: string) => void;
}

/** First variant id of a provider product payload, or the product id when it has none. */
export function firstVariantId(raw: unknown, productId: string): string {
  const r = (raw ?? {}) as {
    variants?: unknown;
    variations?: unknown;
  };
  const first = (list: unknown): string | null => {
    if (!Array.isArray(list) || list.length === 0) return null;
    const item = list[0] as unknown;
    const id =
      item !== null && typeof item === 'object'
        ? (item as { id?: unknown }).id
        : item;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  };
  return first(r.variants) ?? first(r.variations) ?? productId;
}

export async function migrateIntegrationsData(
  db: Sequelize,
  sealer: DataMigrationSealer,
  options: DataMigrationOptions = {},
): Promise<DataMigrationReport> {
  const batch = options.batchSize ?? 200;
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? (() => undefined);
  const report: DataMigrationReport = {
    statusMigrated: 0,
    shopIdBackfilled: 0,
    linksRenamed: 0,
    linkRenameConflicts: 0,
    credentialsResealed: 0,
    credentialsAlreadySealed: 0,
    credentialsUnreadable: 0,
  };

  // 1. ERROR -> NEEDS_REAUTH. One statement: the history rows come from the rows that really changed.
  if (dryRun) {
    const [row] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Integration" WHERE "status" = 'ERROR'`,
      { type: QueryTypes.SELECT },
    );
    report.statusMigrated = Number(row.n);
  } else {
    const changed = await db.query<{ id: string }>(
      `WITH moved AS (
         UPDATE "Integration" SET "status" = 'NEEDS_REAUTH', "updatedAt" = now()
          WHERE "status" = 'ERROR' RETURNING "id"
       ), history AS (
         INSERT INTO "IntegrationHistory" ("integrationId", "fromStatus", "toStatus", "reason")
         SELECT "id", 'ERROR', 'NEEDS_REAUTH', 'data_migration' FROM moved
       )
       SELECT "id" FROM moved`,
      { type: QueryTypes.SELECT },
    );
    report.statusMigrated = changed.length;
  }

  // 2. ExternalLink.shopId, integration by integration.
  const integrations = await db.query<{ id: string }>(
    `SELECT DISTINCT l."integrationId" AS id FROM "ExternalLink" l WHERE l."shopId" IS NULL ORDER BY 1`,
    { type: QueryTypes.SELECT },
  );
  for (const { id } of integrations) {
    if (dryRun) {
      const [row] = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "ExternalLink" WHERE "integrationId" = :id AND "shopId" IS NULL`,
        { replacements: { id }, type: QueryTypes.SELECT },
      );
      report.shopIdBackfilled += Number(row.n);
      continue;
    }
    for (;;) {
      const rows = await db.query<{ externalId: string }>(
        `UPDATE "ExternalLink" l SET "shopId" = i."shopId"
           FROM "Integration" i
          WHERE i."id" = l."integrationId" AND l."integrationId" = :id
            AND l."entity" || '|' || l."externalId" IN (
              SELECT "entity" || '|' || "externalId" FROM "ExternalLink"
               WHERE "integrationId" = :id AND "shopId" IS NULL ORDER BY "entity", "externalId" LIMIT :batch)
        RETURNING l."externalId"`,
        { replacements: { id, batch }, type: QueryTypes.SELECT },
      );
      report.shopIdBackfilled += rows.length;
      if (rows.length < batch) break;
    }
  }

  // 3. externalId rename. Keyset over the primary key; a key without ':' is still in the old shape.
  let after: { integrationId: string; entity: string; externalId: string } = {
    integrationId: '00000000-0000-0000-0000-000000000000',
    entity: '',
    externalId: '',
  };
  for (;;) {
    const links = await db.query<{
      integrationId: string;
      entity: string;
      externalId: string;
      raw: unknown;
    }>(
      `SELECT "integrationId", "entity", "externalId", "raw" FROM "ExternalLink"
        WHERE "entity" = 'product' AND position(':' in "externalId") = 0
          AND ("integrationId", "entity", "externalId") > (:integrationId::uuid, :entity, :externalId)
        ORDER BY "integrationId", "entity", "externalId" LIMIT :batch`,
      { replacements: { ...after, batch }, type: QueryTypes.SELECT },
    );
    if (links.length === 0) break;
    for (const link of links) {
      after = link;
      const target = `${link.externalId}:${firstVariantId(link.raw, link.externalId)}`;
      if (dryRun) {
        report.linksRenamed += 1;
        continue;
      }
      const [updated] = await db.query<{ n: number }>(
        `WITH moved AS (
           UPDATE "ExternalLink" SET "externalId" = :target, "updatedAt" = now()
            WHERE "integrationId" = :integrationId AND "entity" = :entity AND "externalId" = :externalId
              AND NOT EXISTS (SELECT 1 FROM "ExternalLink" t
                               WHERE t."integrationId" = :integrationId AND t."entity" = :entity AND t."externalId" = :target)
           RETURNING 1)
         SELECT count(*)::int AS n FROM moved`,
        { replacements: { ...link, target }, type: QueryTypes.SELECT },
      );
      if (updated.n > 0) report.linksRenamed += 1;
      else report.linkRenameConflicts += 1;
    }
  }

  // 4. Credentials. Keyset by id; compare-and-swap on the sealed value that was read.
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await db.query<{ id: string; credentialsSealed: string }>(
      `SELECT "id", "credentialsSealed" FROM "Integration"
        WHERE "credentialsSealed" IS NOT NULL AND "id" > :lastId::uuid ORDER BY "id" LIMIT :batch`,
      { replacements: { lastId, batch }, type: QueryTypes.SELECT },
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      const context = `integration:${row.id}`;
      const sealed = row.credentialsSealed;
      if (sealed.startsWith('v2.')) {
        try {
          sealer.open(sealed, context);
          report.credentialsAlreadySealed += 1;
        } catch {
          report.credentialsUnreadable += 1;
          log(
            `credentials of integration ${row.id}: v2 value does not open under its context`,
          );
        }
        continue;
      }
      let plaintext: string;
      try {
        plaintext = sealer.open(sealed);
      } catch {
        report.credentialsUnreadable += 1;
        log(
          `credentials of integration ${row.id}: unreadable with the current and previous key`,
        );
        continue;
      }
      if (dryRun) {
        report.credentialsResealed += 1;
        continue;
      }
      const [, meta] = await db.query(
        `UPDATE "Integration" SET "credentialsSealed" = :next, "updatedAt" = now()
          WHERE "id" = :id AND "credentialsSealed" = :sealed`,
        {
          replacements: {
            id: row.id,
            sealed,
            next: sealer.seal(plaintext, context),
          },
        },
      );
      if ((meta as { rowCount?: number }).rowCount)
        report.credentialsResealed += 1;
    }
  }

  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = process.env.NODE_ENV ?? 'development';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const configs = require('../../configs/db.config.js') as Record<
    string,
    Record<string, unknown>
  >;
  const cfg = configs[env];
  if (!cfg) throw new Error(`no database configuration for NODE_ENV=${env}`);
  const db = cfg.url
    ? new Sequelize(cfg.url as string, { ...cfg, logging: false } as never)
    : new Sequelize({ ...cfg, logging: false } as never);
  const settings: Record<string, string | undefined> = {
    auth_kek: process.env.AUTH_KEK,
    auth_kek_previous: process.env.AUTH_KEK_PREVIOUS,
    node_env: env,
  };
  const box = new SecretBox({ get: (k: string) => settings[k] } as never);
  try {
    const report = await migrateIntegrationsData(db, box, {
      batchSize: flag('--batch-size')
        ? Number(flag('--batch-size'))
        : undefined,
      dryRun: args.includes('--dry-run'),
      log: (m) => console.warn(m),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.credentialsUnreadable > 0 || report.linkRenameConflicts > 0)
      process.exitCode = 2;
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
