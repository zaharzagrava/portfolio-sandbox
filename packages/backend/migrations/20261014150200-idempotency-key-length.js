'use strict';

/**
 * S42 G-30: the public API accepts `Idempotency-Key` values of 1 to 255 characters (platform default stays 8 to 128).
 * Widening a varchar is a catalog-only change in PostgreSQL (no table rewrite); the lock is bounded by `lock_timeout`.
 * `down` narrows it again and is meant for a throwaway database only.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "IdempotencyKey" ALTER COLUMN "key" TYPE varchar(255)`,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "IdempotencyKey" ALTER COLUMN "key" TYPE varchar(128)`,
    );
  },
};
