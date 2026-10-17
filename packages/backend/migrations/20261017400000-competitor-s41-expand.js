'use strict';

/**
 * S41 competitor monitor, expand step (III.11; specs/domains/S41-competitor-monitor/data-model.md, research D-16).
 * Additive and idempotent; each group runs in its own short transaction with `SET LOCAL lock_timeout`.
 *
 *  - The two foreign keys of "CompetitorWatch" to "Shop" and "Product" go (IX.4): nothing in this domain reads or
 *    constrains another domain's table; shop and product deletion arrive as events. No foreign key is created.
 *  - "CompetitorWatch": status (ACTIVE/PAUSED), the per-watch evaluation guard (lastEvaluatedObservationNo/PriceMinor).
 *  - "CrawlTarget": observation counter and evaluation cursor, streaks, queue and retirement marks.
 *  - "CompetitorShop": the shop read model (R3) fed by tenancy events, version-guarded.
 *  - Data step: every stored URL is normalised again with the rules of AS-40 (the pure function is copied inline: a
 *    migration may not import application code), duplicates are merged into the oldest target, legacy status
 *    spellings are mapped to the underscore vocabulary, and URLs the new rules refuse are retired.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const TRACKING = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'ref',
  'ref_',
  'spm',
]);

/** Copy of `domain/url.ts#normalizeUrl` (AS-40); returns null where the URL is refused. */
function normalize(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  url.port = '';
  url.hash = '';
  const pairs = [...url.searchParams.entries()].filter(
    ([k]) => !/^utm_/i.test(k) && !TRACKING.has(k.toLowerCase()),
  );
  pairs.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  url.search = new URLSearchParams(pairs).toString();
  if (url.pathname !== '/' && url.pathname.endsWith('/'))
    url.pathname = url.pathname.slice(0, -1);
  const text = url.toString().replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  return text.length > 2048 ? null : text;
}

function legacyStatus(status) {
  if (status == null) return null;
  const http = /^http-(\d{3})$/.exec(status);
  if (http) {
    const code = Number(http[1]);
    if (code === 404 || code === 410) return 'gone';
    if (code === 401 || code === 403) return 'blocked_by_site';
    if (code === 429) return 'http_429';
    if (code === 503) return 'http_503';
    if (code >= 500) return 'http_5xx';
    if (code >= 400) return 'http_4xx';
    return 'http_3xx';
  }
  return status.replace(/-/g, '_');
}

const GROUPS = [
  [
    `ALTER TABLE "CompetitorWatch" DROP CONSTRAINT IF EXISTS "CompetitorWatch_shopId_fkey"`,
    `ALTER TABLE "CompetitorWatch" DROP CONSTRAINT IF EXISTS "CompetitorWatch_productId_fkey"`,
    `ALTER TABLE "CompetitorWatch"
       ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE',
       ADD COLUMN IF NOT EXISTS "lastEvaluatedObservationNo" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "lastEvaluatedPriceMinor" BIGINT NULL`,
    `ALTER TABLE "CompetitorWatch" DROP CONSTRAINT IF EXISTS "CompetitorWatch_status_check"`,
    `ALTER TABLE "CompetitorWatch" ADD CONSTRAINT "CompetitorWatch_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED'))`,
  ],
  [
    `ALTER TABLE "CrawlTarget"
       ADD COLUMN IF NOT EXISTS "observationNo" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "evaluatedNo" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "lastObservedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "noPriceStreak" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "errorStreak" INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMPTZ NULL`,
    `CREATE TABLE IF NOT EXISTS "CompetitorShop" (
       "shopId" UUID PRIMARY KEY,
       "plan" TEXT NULL,
       "status" TEXT NOT NULL,
       "version" INTEGER NOT NULL,
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
  [
    `CREATE INDEX IF NOT EXISTS "CrawlTarget_due_active_idx" ON "CrawlTarget" ("nextCheckAt") WHERE "retiredAt" IS NULL`,
    `CREATE INDEX IF NOT EXISTS "CrawlTarget_retired_idx" ON "CrawlTarget" ("retiredAt") WHERE "retiredAt" IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "CompetitorWatch_shop_list_idx" ON "CompetitorWatch" ("shopId", "createdAt" DESC, "id" DESC)`,
    `CREATE INDEX IF NOT EXISTS "CompetitorWatch_shop_product_idx" ON "CompetitorWatch" ("shopId", "productId")`,
    `CREATE INDEX IF NOT EXISTS "CompetitorWatch_active_target_idx" ON "CompetitorWatch" ("targetId") WHERE "status" = 'ACTIVE'`,
  ],
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const statements of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of statements) await sequelize.query(sql, { transaction });
      });
    }

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(LOCK_TIMEOUT, { transaction });
      const q = (sql, replacements) =>
        sequelize.query(sql, { transaction, replacements, type: 'SELECT' });
      const run = (sql, replacements) =>
        sequelize.query(sql, { transaction, replacements });

      const targets = await q(
        `SELECT "id", "url", "lastStatus", "lastPriceMinor" FROM "CrawlTarget" ORDER BY "id"`,
      );
      const keeper = new Map();
      for (const target of targets) {
        const normalized = normalize(target.url);
        if (normalized === null) {
          await run(
            `UPDATE "CrawlTarget" SET "retiredAt" = now(), "lastStatus" = 'invalid_url' WHERE "id" = :id AND "retiredAt" IS NULL`,
            { id: target.id },
          );
          continue;
        }
        const first = keeper.get(normalized);
        if (first === undefined) {
          keeper.set(normalized, target.id);
          continue;
        }
        // duplicate: re-point the watches that do not collide, drop the rest, then the target
        await run(
          `UPDATE "CompetitorWatch" w SET "targetId" = :keep
             WHERE w."targetId" = :dup
               AND NOT EXISTS (SELECT 1 FROM "CompetitorWatch" o WHERE o."targetId" = :keep AND o."productId" = w."productId")`,
          { keep: first, dup: target.id },
        );
        await run(`DELETE FROM "CompetitorWatch" WHERE "targetId" = :dup`, {
          dup: target.id,
        });
        await run(`DELETE FROM "CrawlTarget" WHERE "id" = :dup`, {
          dup: target.id,
        });
      }
      for (const target of targets) {
        const normalized = normalize(target.url);
        if (normalized === null || keeper.get(normalized) !== target.id)
          continue;
        const host = new URL(normalized).host;
        await run(
          `UPDATE "CrawlTarget" SET "url" = :url, "host" = :host, "lastStatus" = :status WHERE "id" = :id`,
          {
            id: target.id,
            url: normalized,
            host,
            status: legacyStatus(target.lastStatus),
          },
        );
      }
      // Targets that already hold a price count as observed once, and their watches as evaluated: an alert that went out
      // under the old rule is not sent again.
      await run(
        `UPDATE "CrawlTarget" SET "observationNo" = 1, "evaluatedNo" = 1, "lastObservedAt" = COALESCE("lastCheckedAt", now())
           WHERE "lastPriceMinor" IS NOT NULL AND "observationNo" = 0`,
      );
      await run(
        `UPDATE "CompetitorWatch" w SET "lastEvaluatedObservationNo" = 1, "lastEvaluatedPriceMinor" = t."lastPriceMinor"
           FROM "CrawlTarget" t
           WHERE t."id" = w."targetId" AND t."lastPriceMinor" IS NOT NULL AND w."lastEvaluatedObservationNo" = 0`,
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`DROP TABLE IF EXISTS "CompetitorShop"`);
    await sequelize.query(`
      DROP INDEX IF EXISTS "CompetitorWatch_active_target_idx";
      DROP INDEX IF EXISTS "CompetitorWatch_shop_product_idx";
      DROP INDEX IF EXISTS "CompetitorWatch_shop_list_idx";
      DROP INDEX IF EXISTS "CrawlTarget_retired_idx";
      DROP INDEX IF EXISTS "CrawlTarget_due_active_idx";
      ALTER TABLE "CompetitorWatch" DROP CONSTRAINT IF EXISTS "CompetitorWatch_status_check";
      ALTER TABLE "CompetitorWatch"
        DROP COLUMN IF EXISTS "lastEvaluatedPriceMinor",
        DROP COLUMN IF EXISTS "lastEvaluatedObservationNo",
        DROP COLUMN IF EXISTS "status";
      ALTER TABLE "CrawlTarget"
        DROP COLUMN IF EXISTS "retiredAt",
        DROP COLUMN IF EXISTS "queuedAt",
        DROP COLUMN IF EXISTS "errorStreak",
        DROP COLUMN IF EXISTS "noPriceStreak",
        DROP COLUMN IF EXISTS "lastObservedAt",
        DROP COLUMN IF EXISTS "evaluatedNo",
        DROP COLUMN IF EXISTS "observationNo";
    `);
  },
};
