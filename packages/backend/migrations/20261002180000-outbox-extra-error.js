'use strict';

/** Outbox model has carried `extra` (debug data) and `error` (last publish error) since the mailman refactor, but no migration created them. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET LOCAL lock_timeout = '5s';
      ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "extra" JSONB NULL;
      ALTER TABLE "Outbox" ADD COLUMN IF NOT EXISTS "error" JSONB NULL;
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Outbox" DROP COLUMN IF EXISTS "extra", DROP COLUMN IF EXISTS "error"`);
  },
};
