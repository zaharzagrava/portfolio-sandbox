'use strict';

/**
 * S43 expand (specs/domains/S43-webhooks/data-model.md, research.md R-02, R-03, R-15). Additive: the running code keeps
 * working until it is switched. Every statement runs under `lock_timeout = '3s'` and is idempotent.
 *
 *  - `WebhookEndpointHistory` (append-only, kept 400 days, no foreign key: it survives the endpoint)
 *  - `WebhookShopCounter` (`endpoints` BETWEEN 0 AND 20: the store-held limit of FR-005)
 *  - `WebhookEndpoint`: `urlNormalized` (backfilled, NOT NULL), `status` (backfilled from `enabled`, NOT NULL),
 *    unique `(shopId, urlNormalized)`, list index, sweep index, routing index
 *  - a transitional trigger so the code that still writes `enabled` and no `urlNormalized` keeps working until the
 *    switch; it is dropped together with `enabled` (see `20261015100200-webhooks-v2-drop-enabled.js`)
 *
 * Grandfathering (questions.md): an endpoint that duplicates an older endpoint's normalised address gets
 * `#grandfathered-<id>` appended to its `urlNormalized` (a `#` never occurs in a normalised address), and a shop with
 * more than 20 endpoints gets a counter of 20. Nothing is deleted; every such row is listed on the console.
 *
 * `down` is meant for a throwaway database only.
 */
const FACETS = [
  'created',
  'url',
  'events',
  'api_version',
  'status',
  'secret_rotated',
  'previous_secret_expired',
  'deleted',
];

module.exports = {
  async up(queryInterface) {
    const report = { duplicates: [], overLimit: [] };
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, options = {}) =>
        queryInterface.sequelize.query(sql, { transaction, ...options });
      await q(`SET LOCAL lock_timeout = '3s'`);

      await q(`
        CREATE TABLE IF NOT EXISTS "WebhookEndpointHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "endpointId" UUID NOT NULL,
          "shopId" UUID NOT NULL,
          "facet" TEXT NOT NULL CHECK ("facet" IN (${FACETS.map((f) => `'${f}'`).join(', ')})),
          "fromValue" TEXT NULL,
          "toValue" TEXT NULL,
          "actorId" UUID NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "WebhookEndpointHistory_endpoint_idx" ON "WebhookEndpointHistory" ("endpointId", "createdAt");
        CREATE INDEX IF NOT EXISTS "WebhookEndpointHistory_created_idx" ON "WebhookEndpointHistory" ("createdAt");

        CREATE TABLE IF NOT EXISTS "WebhookShopCounter" (
          "shopId" UUID PRIMARY KEY,
          "endpoints" INTEGER NOT NULL DEFAULT 0 CHECK ("endpoints" BETWEEN 0 AND 20)
        );

        ALTER TABLE "WebhookEndpoint" ADD COLUMN IF NOT EXISTS "urlNormalized" TEXT NULL;
        ALTER TABLE "WebhookEndpoint" ADD COLUMN IF NOT EXISTS "status" TEXT NULL;
      `);

      // Backfill. `status` from `enabled`; a failing-disabled reason becomes `auto_failing`, any other `manual`.
      await q(`
        UPDATE "WebhookEndpoint"
           SET "status" = CASE WHEN "enabled" THEN 'enabled' ELSE 'disabled' END
         WHERE "status" IS NULL;
        UPDATE "WebhookEndpoint"
           SET "disabledReason" = NULL
         WHERE "status" = 'enabled' AND "disabledReason" IS NOT NULL;
        UPDATE "WebhookEndpoint"
           SET "disabledReason" = CASE WHEN lower(coalesce("disabledReason", '')) LIKE '%fail%' THEN 'auto_failing' ELSE 'manual' END
         WHERE "status" = 'disabled' AND "disabledReason" IS DISTINCT FROM 'auto_failing' AND "disabledReason" IS DISTINCT FROM 'manual';
        UPDATE "WebhookEndpoint"
           SET "urlNormalized" = regexp_replace(lower(split_part("url", '#', 1)), '^(https://[^/:?]+):443(/|\\?|$)', '\\1\\2')
         WHERE "urlNormalized" IS NULL;
      `);

      // Duplicates: the oldest keeps its address, later ones are marked (not deleted) and reported.
      const [dups] = await q(`
        WITH ranked AS (
          SELECT "id", "shopId", "url",
                 ROW_NUMBER() OVER (PARTITION BY "shopId", "urlNormalized" ORDER BY "createdAt", "id") AS rn
            FROM "WebhookEndpoint"
        )
        UPDATE "WebhookEndpoint" e
           SET "urlNormalized" = e."urlNormalized" || '#grandfathered-' || e."id"
          FROM ranked r
         WHERE r."id" = e."id" AND r.rn > 1
        RETURNING e."id", e."shopId"
      `);
      report.duplicates = dups;

      const [over] = await q(`
        SELECT "shopId", count(*)::int AS endpoints
          FROM "WebhookEndpoint" GROUP BY "shopId" HAVING count(*) > 20
      `);
      report.overLimit = over;

      await q(`
        INSERT INTO "WebhookShopCounter" ("shopId", "endpoints")
        SELECT "shopId", LEAST(count(*), 20)::int FROM "WebhookEndpoint" GROUP BY "shopId"
        ON CONFLICT ("shopId") DO NOTHING;

        ALTER TABLE "WebhookEndpoint" ALTER COLUMN "urlNormalized" SET NOT NULL;
        ALTER TABLE "WebhookEndpoint" ALTER COLUMN "status" SET NOT NULL;
        ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_status_chk";
        ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_status_chk" CHECK ("status" IN ('enabled', 'disabled'));

        CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEndpoint_shop_url_uq" ON "WebhookEndpoint" ("shopId", "urlNormalized");
        CREATE INDEX IF NOT EXISTS "WebhookEndpoint_shop_list_idx" ON "WebhookEndpoint" ("shopId", "createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "WebhookEndpoint_sweep_idx" ON "WebhookEndpoint" ("failingSince")
          WHERE "status" = 'enabled' AND "failingSince" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "WebhookEndpoint_routing_idx" ON "WebhookEndpoint" ("shopId") WHERE "status" = 'enabled';
      `);

      // Transitional: writers that know neither column keep working until the switch (dropped with `enabled`).
      await q(`
        CREATE OR REPLACE FUNCTION "WebhookEndpoint_compat"() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW."urlNormalized" IS NULL THEN
            NEW."urlNormalized" := regexp_replace(lower(split_part(NEW."url", '#', 1)), '^(https://[^/:?]+):443(/|\\?|$)', '\\1\\2');
          END IF;
          IF TG_OP = 'INSERT' THEN
            IF NEW."status" IS NULL THEN
              NEW."status" := CASE WHEN NEW."enabled" THEN 'enabled' ELSE 'disabled' END;
            END IF;
          ELSIF NEW."enabled" IS DISTINCT FROM OLD."enabled" AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
            NEW."status" := CASE WHEN NEW."enabled" THEN 'enabled' ELSE 'disabled' END;
          END IF;
          RETURN NEW;
        END
        $fn$;
        DROP TRIGGER IF EXISTS "WebhookEndpoint_compat_trg" ON "WebhookEndpoint";
        CREATE TRIGGER "WebhookEndpoint_compat_trg" BEFORE INSERT OR UPDATE ON "WebhookEndpoint"
          FOR EACH ROW EXECUTE FUNCTION "WebhookEndpoint_compat"();
      `);
    });

    // The grandfather report: what was kept although it breaks a new rule (nothing is deleted).
    for (const row of report.duplicates)
      console.warn(`[webhooks-v2] grandfathered duplicate address: endpoint ${row.id} of shop ${row.shopId}`);
    for (const row of report.overLimit)
      console.warn(`[webhooks-v2] grandfathered over-limit shop ${row.shopId}: ${row.endpoints} endpoints (counter 20)`);
    console.warn(
      `[webhooks-v2] grandfather report: ${report.duplicates.length} duplicate address(es), ${report.overLimit.length} shop(s) over 20 endpoints`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS "WebhookEndpoint_compat_trg" ON "WebhookEndpoint";
      DROP FUNCTION IF EXISTS "WebhookEndpoint_compat"();
      DROP INDEX IF EXISTS "WebhookEndpoint_routing_idx";
      DROP INDEX IF EXISTS "WebhookEndpoint_sweep_idx";
      DROP INDEX IF EXISTS "WebhookEndpoint_shop_list_idx";
      DROP INDEX IF EXISTS "WebhookEndpoint_shop_url_uq";
      ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_status_chk";
      ALTER TABLE "WebhookEndpoint" DROP COLUMN IF EXISTS "status";
      ALTER TABLE "WebhookEndpoint" DROP COLUMN IF EXISTS "urlNormalized";
      DROP TABLE IF EXISTS "WebhookShopCounter";
      DROP TABLE IF EXISTS "WebhookEndpointHistory";
    `);
  },
};
