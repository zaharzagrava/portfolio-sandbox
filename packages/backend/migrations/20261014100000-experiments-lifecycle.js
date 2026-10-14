'use strict';

/**
 * S39 experiments lifecycle, expand only (research.md R-16). Adds `owner`, `unit`, `version`, `startedBy`, `stoppedBy` and
 * `updatedAt` to `Experiment`, rescales legacy weights to integers summing to 10,000, adds the variant-count check and
 * the keyset index, and creates the append-only `ExperimentAudit`. The exclusion constraint on running layer ranges is
 * kept. Idempotent (`IF NOT EXISTS`, drop-then-add for constraints) and every statement runs under a 5 s `lock_timeout`.
 */

const TOTAL = 10_000;

/** Largest-remainder rescale of positive weights to integers summing to 10,000; null when the row cannot be rescaled. */
function rescale(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const weights = variants.map((v) => Number(v && v.weight));
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.every(Number.isInteger) && sum === TOTAL) return null;
  const exact = weights.map((w) => (w * TOTAL) / sum);
  const floors = exact.map(Math.floor);
  let missing = TOTAL - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (missing <= 0) break;
    floors[i] += 1;
    missing -= 1;
  }
  return variants.map((v, i) => ({ ...v, weight: floors[i] }));
}

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "owner" TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "unit" TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "startedBy" TEXT NULL;
        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "stoppedBy" TEXT NULL;
        ALTER TABLE "Experiment" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();

        ALTER TABLE "Experiment" DROP CONSTRAINT IF EXISTS "Experiment_unit_check";
        ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_unit_check" CHECK ("unit" IN ('user', 'visitor'));
        ALTER TABLE "Experiment" DROP CONSTRAINT IF EXISTS "Experiment_variants_count_check";
        ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_variants_count_check"
          CHECK (jsonb_typeof("variants") = 'array' AND jsonb_array_length("variants") BETWEEN 2 AND 10) NOT VALID;
        CREATE INDEX IF NOT EXISTS "Experiment_keyset_idx" ON "Experiment" ("createdAt" DESC, "key" DESC);

        CREATE TABLE IF NOT EXISTS "ExperimentAudit" (
          "id" UUID PRIMARY KEY,
          "experimentKey" TEXT NOT NULL,
          "action" TEXT NOT NULL CHECK ("action" IN ('create', 'update', 'start', 'stop')),
          "actorId" TEXT NOT NULL,
          "requestId" TEXT NULL,
          "before" JSONB NULL,
          "after" JSONB NOT NULL,
          "at" TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "ExperimentAudit_keyset_idx" ON "ExperimentAudit" ("experimentKey", "at" DESC, "id" DESC);
        `,
        { transaction },
      );

      const [rows] = await sequelize.query(
        `SELECT "key", "variants" FROM "Experiment"`,
        { transaction },
      );
      for (const row of rows) {
        const next = rescale(row.variants);
        if (!next) continue;
        await sequelize.query(
          `UPDATE "Experiment" SET "variants" = CAST(:variants AS jsonb) WHERE "key" = :key`,
          {
            transaction,
            replacements: { key: row.key, variants: JSON.stringify(next) },
          },
        );
      }
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        DROP TABLE IF EXISTS "ExperimentAudit";
        DROP INDEX IF EXISTS "Experiment_keyset_idx";
        ALTER TABLE "Experiment" DROP CONSTRAINT IF EXISTS "Experiment_variants_count_check";
        ALTER TABLE "Experiment" DROP CONSTRAINT IF EXISTS "Experiment_unit_check";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "updatedAt";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "stoppedBy";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "startedBy";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "version";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "unit";
        ALTER TABLE "Experiment" DROP COLUMN IF EXISTS "owner";
        `,
        { transaction },
      );
    });
  },
};
