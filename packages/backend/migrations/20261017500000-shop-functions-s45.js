'use strict';

/**
 * S45 seller discount functions, expand then contract in one reviewed migration (III.11;
 * specs/domains/S45-discount-functions/data-model.md). Each group runs in its own short transaction with
 * `SET LOCAL lock_timeout`.
 *
 *  - "ShopFunction": updatedAt, generated activeStatus, unique lower(name), keyset index, name check.
 *  - "ShopFunctionVersion": rejectionReason, judgeAttempts, updatedAt, judgedAt, status/length/version checks, partial
 *    unique index (one ACTIVE per function), the unique triple the pointer foreign key targets, recovery index.
 *  - "ShopFunctionTestCase": version (null = the current editable suite; set = the frozen copy of that version).
 *  - "ShopFunctionVersionHistory": append-only status history.
 *  - The pointer foreign key ShopFunction(id, activeVersion, activeStatus) -> ShopFunctionVersion (deferrable).
 *  - Data step: duplicates by lower(name) get a "-<n>" suffix, inconsistent ACTIVE rows are repaired, test inputs are
 *    rewritten from unitPrice to unitPriceMinor, every existing version gets one history row.
 *  - Contract: the foreign key to "Shop" and UNIQUE (shopId, name) go (IX.4).
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  // ---- ShopFunction -------------------------------------------------------------------------------------------
  `
  ALTER TABLE "ShopFunction" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
  UPDATE "ShopFunction" SET "updatedAt" = "createdAt";
  UPDATE "ShopFunction" SET "name" = left("name", 60) WHERE char_length("name") > 60;
  UPDATE "ShopFunction" f SET "name" = left(f."name", 55) || '-' || d.rn
    FROM (SELECT "id", row_number() OVER (PARTITION BY "shopId", lower("name") ORDER BY "createdAt", "id") AS rn
          FROM "ShopFunction") d
    WHERE f."id" = d."id" AND d.rn > 1;
  ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_name_len";
  ALTER TABLE "ShopFunction" ADD CONSTRAINT "ShopFunction_name_len" CHECK (char_length("name") BETWEEN 1 AND 60);
  CREATE UNIQUE INDEX IF NOT EXISTS "ShopFunction_shop_lower_name_uq" ON "ShopFunction" ("shopId", lower("name"));
  CREATE INDEX IF NOT EXISTS "ShopFunction_shop_created_idx" ON "ShopFunction" ("shopId", "createdAt" DESC, "id" DESC);
  `,
  // ---- ShopFunctionVersion ------------------------------------------------------------------------------------
  `
  ALTER TABLE "ShopFunctionVersion"
    ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT NULL,
    ADD COLUMN IF NOT EXISTS "judgeAttempts" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS "judgedAt" TIMESTAMPTZ NULL;
  UPDATE "ShopFunctionVersion" SET "updatedAt" = "createdAt";
  UPDATE "ShopFunctionVersion" SET "judgedAt" = "createdAt" WHERE "status" IN ('ACTIVE', 'REJECTED', 'SUPERSEDED');
  -- only the newest ACTIVE version of a function stays ACTIVE
  UPDATE "ShopFunctionVersion" v SET "status" = 'SUPERSEDED'
    WHERE v."status" = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM "ShopFunctionVersion" n WHERE n."functionId" = v."functionId" AND n."status" = 'ACTIVE' AND n."version" > v."version");
  -- activeVersion names the ACTIVE version, or nothing
  UPDATE "ShopFunction" f SET "activeVersion" = NULL
    WHERE f."activeVersion" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "ShopFunctionVersion" v WHERE v."functionId" = f."id" AND v."version" = f."activeVersion" AND v."status" = 'ACTIVE');
  UPDATE "ShopFunction" f SET "activeVersion" = v."version"
    FROM "ShopFunctionVersion" v
    WHERE v."functionId" = f."id" AND v."status" = 'ACTIVE' AND f."activeVersion" IS DISTINCT FROM v."version";
  ALTER TABLE "ShopFunctionVersion" DROP CONSTRAINT IF EXISTS "ShopFunctionVersion_source_len";
  ALTER TABLE "ShopFunctionVersion" ADD CONSTRAINT "ShopFunctionVersion_source_len" CHECK (length("source") BETWEEN 1 AND 20000);
  ALTER TABLE "ShopFunctionVersion" DROP CONSTRAINT IF EXISTS "ShopFunctionVersion_version_pos";
  ALTER TABLE "ShopFunctionVersion" ADD CONSTRAINT "ShopFunctionVersion_version_pos" CHECK ("version" >= 1);
  ALTER TABLE "ShopFunctionVersion" DROP CONSTRAINT IF EXISTS "ShopFunctionVersion_rejection_reason";
  ALTER TABLE "ShopFunctionVersion" ADD CONSTRAINT "ShopFunctionVersion_rejection_reason" CHECK ("rejectionReason" IN ('judge_unavailable'));
  CREATE UNIQUE INDEX IF NOT EXISTS "ShopFunctionVersion_one_active_uq" ON "ShopFunctionVersion" ("functionId") WHERE "status" = 'ACTIVE';
  CREATE UNIQUE INDEX IF NOT EXISTS "ShopFunctionVersion_triple_uq" ON "ShopFunctionVersion" ("functionId", "version", "status");
  CREATE INDEX IF NOT EXISTS "ShopFunctionVersion_pending_idx" ON "ShopFunctionVersion" ("status", "updatedAt") WHERE "status" IN ('QUEUED', 'TESTING');
  `,
  // ---- ShopFunctionTestCase -----------------------------------------------------------------------------------
  `
  ALTER TABLE "ShopFunctionTestCase" ADD COLUMN IF NOT EXISTS "version" INTEGER NULL;
  UPDATE "ShopFunctionTestCase" SET "name" = left("name", 80) WHERE char_length("name") > 80;
  UPDATE "ShopFunctionTestCase" c SET "name" = left(c."name", 75) || '-' || d.rn
    FROM (SELECT "id", row_number() OVER (PARTITION BY "functionId", COALESCE("version", 0), "name" ORDER BY "id") AS rn
          FROM "ShopFunctionTestCase") d
    WHERE c."id" = d."id" AND d.rn > 1;
  ALTER TABLE "ShopFunctionTestCase" DROP CONSTRAINT IF EXISTS "ShopFunctionTestCase_name_len";
  ALTER TABLE "ShopFunctionTestCase" ADD CONSTRAINT "ShopFunctionTestCase_name_len" CHECK (char_length("name") BETWEEN 1 AND 80);
  CREATE UNIQUE INDEX IF NOT EXISTS "ShopFunctionTestCase_name_uq" ON "ShopFunctionTestCase" ("functionId", COALESCE("version", 0), "name");
  ALTER TABLE "ShopFunctionTestCase" DROP CONSTRAINT IF EXISTS "ShopFunctionTestCase_frozen_fk";
  ALTER TABLE "ShopFunctionTestCase" ADD CONSTRAINT "ShopFunctionTestCase_frozen_fk"
    FOREIGN KEY ("functionId", "version") REFERENCES "ShopFunctionVersion" ("functionId", "version") ON DELETE CASCADE;
  -- the input field is unitPriceMinor from now on
  UPDATE "ShopFunctionTestCase" SET "input" = jsonb_set("input", '{lines}', (
      SELECT COALESCE(jsonb_agg(CASE WHEN l ? 'unitPrice' THEN (l - 'unitPrice') || jsonb_build_object('unitPriceMinor', l -> 'unitPrice') ELSE l END), '[]'::jsonb)
      FROM jsonb_array_elements("input" -> 'lines') l))
    WHERE jsonb_typeof("input" -> 'lines') = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements("input" -> 'lines') l WHERE l ? 'unitPrice');
  `,
  // ---- ShopFunctionVersionHistory -----------------------------------------------------------------------------
  `
  CREATE TABLE IF NOT EXISTS "ShopFunctionVersionHistory" (
    "id" UUID PRIMARY KEY DEFAULT uuidv7(),
    "functionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "fromStatus" TEXT NULL,
    "toStatus" TEXT NOT NULL CHECK ("toStatus" IN ('QUEUED', 'TESTING', 'ACTIVE', 'REJECTED', 'SUPERSEDED')),
    "actorId" UUID NULL,
    "reason" TEXT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ("fromStatus" IS NULL OR "fromStatus" IN ('QUEUED', 'TESTING', 'ACTIVE', 'REJECTED', 'SUPERSEDED')),
    FOREIGN KEY ("functionId", "version") REFERENCES "ShopFunctionVersion" ("functionId", "version") ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS "ShopFunctionVersionHistory_version_idx" ON "ShopFunctionVersionHistory" ("functionId", "version", "at", "id");
  INSERT INTO "ShopFunctionVersionHistory" ("functionId", "version", "fromStatus", "toStatus", "actorId", "reason", "at")
    SELECT v."functionId", v."version", NULL, v."status", v."createdBy", NULL, v."createdAt"
    FROM "ShopFunctionVersion" v
    WHERE NOT EXISTS (SELECT 1 FROM "ShopFunctionVersionHistory" h WHERE h."functionId" = v."functionId" AND h."version" = v."version");
  `,
  // ---- the pointer foreign key and the contract step ---------------------------------------------------------
  `
  ALTER TABLE "ShopFunction" ADD COLUMN IF NOT EXISTS "activeStatus" TEXT
    GENERATED ALWAYS AS (CASE WHEN "activeVersion" IS NULL THEN NULL ELSE 'ACTIVE' END) STORED;
  ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_active_version_fk";
  ALTER TABLE "ShopFunction" ADD CONSTRAINT "ShopFunction_active_version_fk"
    FOREIGN KEY ("id", "activeVersion", "activeStatus") REFERENCES "ShopFunctionVersion" ("functionId", "version", "status")
    MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_shopId_fkey";
  ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_shopId_name_key";
  `,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const sql of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        await sequelize.query(sql, { transaction });
      });
    }
  },

  /** Restores only the constraints the contract step dropped; data is not un-rewritten. */
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(LOCK_TIMEOUT, { transaction });
      await sequelize.query(
        `
        ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_active_version_fk";
        ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_shopId_name_key";
        ALTER TABLE "ShopFunction" ADD CONSTRAINT "ShopFunction_shopId_name_key" UNIQUE ("shopId", "name");
        ALTER TABLE "ShopFunction" DROP CONSTRAINT IF EXISTS "ShopFunction_shopId_fkey";
        ALTER TABLE "ShopFunction" ADD CONSTRAINT "ShopFunction_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") NOT VALID;
        `,
        { transaction },
      );
    });
  },
};
