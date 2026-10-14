'use strict';

/**
 * S44 contract (data-model.md, step 3): the widget owns its tables and keeps no foreign key into another owner's table
 * (IX.4). Drops `WidgetSite.shopId -> Shop`; the constraint name is read from the catalog and dropped `IF EXISTS`. The
 * shop copy columns the expand migration added are filled by `infra/widget-shop-copy.backfill.ts` before this runs in
 * production.
 *
 * `down` re-adds the constraint `NOT VALID` so that it cannot fail on rows written while it was absent.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      const [rows] = await q(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
          WHERE con.contype = 'f' AND rel.relname = 'WidgetSite' AND att.attname = 'shopId'`,
      );
      for (const { conname } of rows)
        await q(`ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "${conname}"`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(
        `ALTER TABLE "WidgetSite" DROP CONSTRAINT IF EXISTS "WidgetSite_shopId_fkey"`,
      );
      await q(
        `ALTER TABLE "WidgetSite" ADD CONSTRAINT "WidgetSite_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`,
      );
    });
  },
};
