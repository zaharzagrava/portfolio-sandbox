'use strict';

/**
 * S28 notifications, expand step 4: "PushDevice"."tokenHash" = SHA-256 of the token (hex, 64 chars). The token stays a
 * column (sending needs it) but is never returned, logged or put in a URL; the hash is what lookups and logs use.
 * Backfill in batches (resumable: only rows with a NULL hash are touched). "token" and its unique index stay.
 */
const BATCH = 1000;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(
        `ALTER TABLE "PushDevice" ADD COLUMN IF NOT EXISTS "tokenHash" CHAR(64) NULL`,
      );
      // The device id of `DELETE /notifications/devices/:deviceId`: added without a default (no rewrite), the default
      // is set afterwards (metadata only) so new rows get one; NOT NULL and the unique index follow separately.
      await q(
        `ALTER TABLE "PushDevice" ADD COLUMN IF NOT EXISTS "id" UUID NULL`,
      );
      await q(
        `ALTER TABLE "PushDevice" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
      );
    });

    for (;;) {
      const [, meta] = await sequelize.query(`
        UPDATE "PushDevice" SET
          "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex'),
          "id" = COALESCE("id", gen_random_uuid())
        WHERE "token" IN (
          SELECT "token" FROM "PushDevice" WHERE "tokenHash" IS NULL OR "id" IS NULL LIMIT ${BATCH}
        )
      `);
      if ((meta.rowCount ?? 0) < BATCH) break;
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "PushDevice" DROP COLUMN IF EXISTS "tokenHash";
      ALTER TABLE "PushDevice" DROP COLUMN IF EXISTS "id";
    `);
  },
};
