'use strict';

/**
 * SD-34: write-behind view counter target. Adding a column with a constant
 * default is metadata-only since PG 11 (no table rewrite, brief lock).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET lock_timeout = '5s';
      ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "viewCount" BIGINT NOT NULL DEFAULT 0;
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Product" DROP COLUMN IF EXISTS "viewCount";`);
  },
};
