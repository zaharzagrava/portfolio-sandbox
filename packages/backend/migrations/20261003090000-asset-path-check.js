'use strict';

/**
 * The original CHECK used `{1,1000}`, but Postgres regexes allow at most 255 repetitions, so every insert
 * failed with "invalid repetition count(s)". Same rule, with the length checked separately.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET LOCAL lock_timeout = '5s';
      ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_path_check";
      ALTER TABLE "Asset" ADD CONSTRAINT "Asset_path_check" CHECK ("path" ~ '^/[^\\x00]+$' AND length("path") <= 1000);
    `);
  },

  async down() {
    // The previous constraint could never be satisfied; nothing to restore.
  },
};
