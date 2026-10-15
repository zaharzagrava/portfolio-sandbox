'use strict';

/**
 * S43 contract, step 1 (data-model.md, research.md R-15): `WebhookEndpoint` keeps no foreign key into another owner's
 * table (IX.4). Drops `WebhookEndpoint."shopId" -> "Shop"`; the constraint name is read from the catalog and dropped
 * `IF EXISTS`, under `lock_timeout`. The column `enabled` and the transitional trigger of the expand migration are
 * dropped by `20261015100200-webhooks-v2-drop-enabled.js` once no code reads `enabled`.
 *
 * `down` re-adds the constraint `NOT VALID` so that it cannot fail on rows written while it was absent.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, options = {}) =>
        queryInterface.sequelize.query(sql, { transaction, ...options });
      await q(`SET LOCAL lock_timeout = '3s'`);
      const [rows] = await q(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
          WHERE con.contype = 'f' AND rel.relname = 'WebhookEndpoint' AND att.attname = 'shopId'`,
      );
      for (const { conname } of rows) {
        await q(`ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "${conname}"`);
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "WebhookEndpoint_shopId_fkey"`);
      await q(
        `ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`,
      );
    });
  },
};
