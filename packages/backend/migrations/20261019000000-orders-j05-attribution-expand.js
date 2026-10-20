'use strict';

/**
 * J05 checkout attribution, expand step (III.11; specs/journeys/J05-engagement-loop/data-model.md). Additive and
 * idempotent: the owner of the credited link, frozen on the order at checkout. Never returned by any API.
 */
const STATEMENTS = [
  `ALTER TABLE "BisOrder" ADD COLUMN IF NOT EXISTS "attributionOwnerId" UUID`,
];

module.exports = {
  STATEMENTS,
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '5s'`, {
        transaction,
      });
      for (const sql of STATEMENTS)
        await queryInterface.sequelize.query(sql, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "BisOrder" DROP COLUMN IF EXISTS "attributionOwnerId"`,
    );
  },
};
