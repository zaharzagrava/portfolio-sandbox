'use strict';

/**
 * S27 brand stories, contract step (III.11, B4). Runs after the expand step (`20261016100000-stories-s27-expand.js`)
 * once no code writes the status `SCHEDULED`: a schedule is the attribute `scheduledAt`. Rows that still carry
 * `SCHEDULED` go back to the status they had before (`PUBLISHED` when a version is live, else `DRAFT`) and keep their
 * `scheduledAt`; the status check then drops the value. Idempotent, short lock timeout, one short transaction.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(`ALTER TABLE "Story" DROP CONSTRAINT IF EXISTS "Story_status_check"`);
      await q(
        `UPDATE "Story" SET "status" = CASE WHEN "publishedVersion" IS NULL THEN 'DRAFT' ELSE 'PUBLISHED' END WHERE "status" = 'SCHEDULED'`,
      );
      await q(
        `ALTER TABLE "Story" ADD CONSTRAINT "Story_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))`,
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(`ALTER TABLE "Story" DROP CONSTRAINT IF EXISTS "Story_status_check"`);
      await q(
        `ALTER TABLE "Story" ADD CONSTRAINT "Story_status_check" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'))`,
      );
    });
  },
};
