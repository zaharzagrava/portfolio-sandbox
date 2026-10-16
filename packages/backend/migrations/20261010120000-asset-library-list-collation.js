'use strict';

/**
 * S31 listing order. Paths are listed in byte order (`COLLATE "C"`), so the order is the same on every database and
 * `%`, `_` and letters sort predictably; the keyset index must carry the same collation to serve the page query.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`SET LOCAL lock_timeout = '5s'`);
      await run(`DROP INDEX IF EXISTS "Asset_shop_list_idx"`);
      await run(
        `CREATE INDEX IF NOT EXISTS "Asset_shop_list_c_idx" ON "Asset" ("shopId", ("path" COLLATE "C"), "id") WHERE "status" = 'ACTIVE'`,
      );
    });
  },

  async down() {
    // The previous index only served a different order.
  },
};
