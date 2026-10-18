'use strict';

/**
 * J03 booking voucher, expand step (III.11, IX.4; specs/journeys/J03-launch-day/data-model.md). Additive and idempotent:
 * every statement is `IF NOT EXISTS`, so a second run changes nothing. No foreign key (`launchEventId` and `shopId` belong
 * to other domains), no backfill (the table is new).
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "Voucher" (
     "id" UUID PRIMARY KEY DEFAULT uuidv7(),
     "holdId" UUID NOT NULL,
     "launchEventId" UUID NOT NULL,
     "shopId" UUID NOT NULL,
     "userId" UUID NOT NULL,
     "seatCount" INTEGER NOT NULL CHECK ("seatCount" >= 1),
     "status" TEXT NOT NULL DEFAULT 'ISSUED' CHECK ("status" IN ('ISSUED')),
     "createdAt" TIMESTAMPTZ NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_voucher_hold" ON "Voucher" ("holdId")`,
  `CREATE INDEX IF NOT EXISTS "ix_voucher_user_event_created" ON "Voucher" ("userId", "launchEventId", "createdAt" DESC, "id" DESC)`,
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
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "Voucher"`);
  },
};
