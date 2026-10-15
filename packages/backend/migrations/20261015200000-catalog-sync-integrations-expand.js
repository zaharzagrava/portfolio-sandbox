'use strict';

/**
 * S08 expand (specs/domains/S08-integrations/data-model.md, gaps.md A41/A43/A45). Additive: the running code keeps
 * working until it is switched. Every statement runs under `lock_timeout = '3s'` and is idempotent. Not run at startup.
 *
 *  - `Integration`: lifecycle/scheduler columns, status check widened (`ERROR` stays valid until the data script
 *    `scripts/catalog-sync/migrate-integrations-data.ts` has run and the contract step narrows it), `provider` check
 *    unchanged (`fake` is removed by the contract step), FK `shopId -> Shop` dropped (A43), `credentialsSealed`
 *    nullable (erased on disconnect), partial unique `(provider, externalShop) WHERE status <> 'DISCONNECTED'`
 *  - `SyncCursor`: lease columns; `ExternalLink`: shop id (backfilled by the data script), state, digests, stock
 *    bookkeeping; `lastHash` becomes nullable (dropped by the contract step)
 *  - `SyncQuarantine`: dedupe/status/occurrence columns, unique OPEN per `(integrationId, entity, dedupeKey)`
 *  - new: IntegrationHistory, IntegrationInstall, SyncRun, StockConflict, WebhookReceipt, CatalogReconciliationRun
 *    (named apart from the payments-owned `ReconciliationRun` of the ledger migration)
 *    (`BEFORE UPDATE` trigger refuses changes to a finished run; DELETE stays allowed)
 *
 * Data steps (link id rename, shopId backfill, ERROR -> NEEDS_REAUTH, credential re-seal) are a separate script.
 * `down` is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);

      // ---- Integration -------------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_shopId_fkey";
        ALTER TABLE "Integration" ALTER COLUMN "credentialsSealed" DROP NOT NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "pausedReason" TEXT NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "locationId" TEXT NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "connectedBy" UUID NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "breakerOpenUntil" TIMESTAMPTZ NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "nextSyncAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

        ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_status_check";
        ALTER TABLE "Integration" ADD CONSTRAINT "Integration_status_check"
          CHECK ("status" IN ('ACTIVE', 'PAUSED', 'NEEDS_REAUTH', 'DISCONNECTED', 'ERROR'));
        ALTER TABLE "Integration" DROP CONSTRAINT IF EXISTS "Integration_pausedReason_check";
        ALTER TABLE "Integration" ADD CONSTRAINT "Integration_pausedReason_check"
          CHECK ("pausedReason" IS NULL OR ("status" = 'PAUSED' AND "pausedReason" IN ('seller', 'shop_offboarding')));

        CREATE UNIQUE INDEX IF NOT EXISTS "Integration_provider_externalShop_live_uq"
          ON "Integration" ("provider", "externalShop") WHERE "status" <> 'DISCONNECTED';
        CREATE INDEX IF NOT EXISTS "Integration_shop_created_idx" ON "Integration" ("shopId", "createdAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Integration_status_nextSync_idx" ON "Integration" ("status", "nextSyncAt");
      `);

      // ---- SyncCursor --------------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "SyncCursor" ADD COLUMN IF NOT EXISTS "leaseHolder" TEXT NULL;
        ALTER TABLE "SyncCursor" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMPTZ NULL;
        ALTER TABLE "SyncCursor" ADD COLUMN IF NOT EXISTS "fence" BIGINT NOT NULL DEFAULT 0;
      `);

      // ---- ExternalLink ------------------------------------------------------------------------------------------
      await q(`
        DO $do$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema() AND table_name = 'ExternalLink' AND column_name = 'lastHash') THEN
            ALTER TABLE "ExternalLink" ALTER COLUMN "lastHash" DROP NOT NULL;
          END IF;
        END $do$;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "shopId" UUID NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "state" TEXT NOT NULL DEFAULT 'ACTIVE';
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "contentDigest" TEXT NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "syncedStock" INTEGER NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "remoteUpdatedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "lastStockWriteAt" TIMESTAMPTZ NULL;
        ALTER TABLE "ExternalLink" ADD COLUMN IF NOT EXISTS "lastLocalVersion" INTEGER NULL;
        ALTER TABLE "ExternalLink" DROP CONSTRAINT IF EXISTS "ExternalLink_state_check";
        ALTER TABLE "ExternalLink" ADD CONSTRAINT "ExternalLink_state_check"
          CHECK ("state" IN ('ACTIVE', 'UNLISTED', 'DELETED_AT_PROVIDER', 'IGNORED'));
        ALTER TABLE "ExternalLink" DROP CONSTRAINT IF EXISTS "ExternalLink_raw_size_check";
        ALTER TABLE "ExternalLink" ADD CONSTRAINT "ExternalLink_raw_size_check"
          CHECK (octet_length("raw"::text) <= 262144);
        CREATE INDEX IF NOT EXISTS "ExternalLink_shop_local_idx" ON "ExternalLink" ("shopId", "localId");
      `);

      // ---- SyncQuarantine ----------------------------------------------------------------------------------------
      await q(`
        ALTER TABLE "SyncQuarantine" ALTER COLUMN "reason" DROP NOT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "payloadDigest" TEXT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "reasonCode" TEXT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "message" TEXT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'OPEN';
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "occurrences" INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now();
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now();
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "resolution" TEXT NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "dismissedBy" UUID NULL;
        ALTER TABLE "SyncQuarantine" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "SyncQuarantine" DROP CONSTRAINT IF EXISTS "SyncQuarantine_status_check";
        ALTER TABLE "SyncQuarantine" ADD CONSTRAINT "SyncQuarantine_status_check"
          CHECK ("status" IN ('OPEN', 'RESOLVED', 'DISMISSED'));
        ALTER TABLE "SyncQuarantine" DROP CONSTRAINT IF EXISTS "SyncQuarantine_resolution_check";
        ALTER TABLE "SyncQuarantine" ADD CONSTRAINT "SyncQuarantine_resolution_check"
          CHECK ("resolution" IS NULL OR "resolution" IN ('fixed_at_provider', 'dismissed', 'expired'));
        ALTER TABLE "SyncQuarantine" DROP CONSTRAINT IF EXISTS "SyncQuarantine_message_check";
        ALTER TABLE "SyncQuarantine" ADD CONSTRAINT "SyncQuarantine_message_check"
          CHECK ("message" IS NULL OR char_length("message") <= 500);

        -- Existing rows: one open entry per (integration, entity, dedupe key); older duplicates are closed, not deleted.
        UPDATE "SyncQuarantine" SET "dedupeKey" = coalesce("externalId", "id"::text), "reasonCode" = coalesce("reasonCode", 'legacy'),
               "firstSeenAt" = "createdAt", "lastSeenAt" = "createdAt"
         WHERE "dedupeKey" IS NULL;
        UPDATE "SyncQuarantine" q SET "status" = 'DISMISSED', "resolution" = 'expired', "resolvedAt" = now()
          FROM (SELECT "id", row_number() OVER (PARTITION BY "integrationId", "entity", "dedupeKey"
                                                ORDER BY "createdAt" DESC, "id" DESC) AS rn
                  FROM "SyncQuarantine" WHERE "status" = 'OPEN') d
         WHERE q."id" = d."id" AND d.rn > 1;
        CREATE UNIQUE INDEX IF NOT EXISTS "SyncQuarantine_open_dedupe_uq"
          ON "SyncQuarantine" ("integrationId", "entity", "dedupeKey") WHERE "status" = 'OPEN';
      `);

      // ---- New tables --------------------------------------------------------------------------------------------
      await q(`
        CREATE TABLE IF NOT EXISTS "IntegrationHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "integrationId" UUID NOT NULL,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "reason" TEXT NULL,
          "actorId" UUID NULL,
          "at" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "IntegrationHistory_integration_at_idx" ON "IntegrationHistory" ("integrationId", "at");

        CREATE TABLE IF NOT EXISTS "IntegrationInstall" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL,
          "userId" UUID NOT NULL,
          "shopDomain" TEXT NOT NULL,
          "stateDigest" TEXT NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
          "consumedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT "IntegrationInstall_stateDigest_uq" UNIQUE ("stateDigest")
        );
        CREATE INDEX IF NOT EXISTS "IntegrationInstall_expires_idx" ON "IntegrationInstall" ("expiresAt");

        CREATE TABLE IF NOT EXISTS "SyncRun" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "integrationId" UUID NOT NULL,
          "kind" TEXT NOT NULL CHECK ("kind" IN ('incremental', 'backfill', 'one', 'reconcile')),
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL,
          "outcome" TEXT NULL CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'completed_with_quarantine', 'yielded',
            'failed', 'skipped_locked', 'skipped_breaker_open', 'skipped_shop_not_active', 'halted_schema_drift')),
          "counters" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "detail" TEXT NULL
        );
        CREATE INDEX IF NOT EXISTS "SyncRun_integration_started_idx" ON "SyncRun" ("integrationId", "startedAt" DESC);
        CREATE INDEX IF NOT EXISTS "SyncRun_started_idx" ON "SyncRun" ("startedAt");

        CREATE TABLE IF NOT EXISTS "StockConflict" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "integrationId" UUID NOT NULL,
          "shopId" UUID NOT NULL,
          "externalId" TEXT NOT NULL,
          "productId" UUID NULL,
          "kind" TEXT NOT NULL CHECK ("kind" IN ('oversold', 'quantity_limit')),
          "base" INTEGER NOT NULL,
          "local" INTEGER NOT NULL,
          "remote" INTEGER NOT NULL,
          "merged" INTEGER NULL,
          "resolvedTo" INTEGER NULL,
          "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'DISMISSED')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "dismissedBy" UUID NULL,
          "dismissedAt" TIMESTAMPTZ NULL,
          "resolution" TEXT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "StockConflict_open_uq"
          ON "StockConflict" ("integrationId", "externalId", "base", "local", "remote") WHERE "status" = 'OPEN';
        CREATE INDEX IF NOT EXISTS "StockConflict_shop_status_idx" ON "StockConflict" ("shopId", "status", "createdAt" DESC);

        CREATE TABLE IF NOT EXISTS "WebhookReceipt" (
          "integrationId" UUID NOT NULL,
          "deliveryId" TEXT NOT NULL,
          "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("integrationId", "deliveryId")
        );
        CREATE INDEX IF NOT EXISTS "WebhookReceipt_received_idx" ON "WebhookReceipt" ("receivedAt");

        CREATE TABLE IF NOT EXISTS "CatalogReconciliationRun" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "integrationId" UUID NOT NULL,
          "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "finishedAt" TIMESTAMPTZ NULL,
          "outcome" TEXT NULL CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'aborted_mass_delete', 'failed')),
          "counts" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "findings" JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("findings") = 'array' AND jsonb_array_length("findings") <= 1000),
          "truncated" BOOLEAN NOT NULL DEFAULT false,
          "previousRunId" UUID NULL
        );
        CREATE INDEX IF NOT EXISTS "CatalogReconciliationRun_integration_started_idx" ON "CatalogReconciliationRun" ("integrationId", "startedAt" DESC);

        CREATE OR REPLACE FUNCTION "CatalogReconciliationRun_immutable"() RETURNS trigger AS $fn$
        BEGIN
          IF OLD."finishedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'CatalogReconciliationRun % is finished and immutable', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS "CatalogReconciliationRun_immutable_trg" ON "CatalogReconciliationRun";
        CREATE TRIGGER "CatalogReconciliationRun_immutable_trg" BEFORE UPDATE ON "CatalogReconciliationRun"
          FOR EACH ROW EXECUTE FUNCTION "CatalogReconciliationRun_immutable"();
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "CatalogReconciliationRun", "WebhookReceipt", "StockConflict", "SyncRun", "IntegrationInstall", "IntegrationHistory";
      DROP FUNCTION IF EXISTS "CatalogReconciliationRun_immutable"();
      DROP INDEX IF EXISTS "SyncQuarantine_open_dedupe_uq";
      DROP INDEX IF EXISTS "Integration_provider_externalShop_live_uq", "Integration_shop_created_idx", "Integration_status_nextSync_idx";
    `);
  },
};
