'use strict';

/**
 * J05 affiliate conversions, expand step (III.11, IX.4; specs/journeys/J05-engagement-loop/data-model.md). Additive and
 * idempotent. No foreign key: `orderId` and `ownerId` belong to other domains; `orderId` is internal and never exposed.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "AffiliateConversion" (
     "id" UUID PRIMARY KEY,
     "linkCode" TEXT NOT NULL,
     "ownerId" UUID NOT NULL,
     "orderId" UUID NOT NULL,
     "amountMinor" BIGINT NOT NULL DEFAULT 0 CHECK ("amountMinor" >= 0),
     "currency" TEXT NOT NULL DEFAULT '',
     "status" TEXT NOT NULL CHECK ("status" IN ('CONFIRMED', 'REVERSED', 'PENDING_REFUND')),
     "refundedMinor" BIGINT NOT NULL DEFAULT 0 CHECK ("refundedMinor" >= 0),
     "orderVersion" INTEGER NOT NULL DEFAULT 0,
     "paidAt" TIMESTAMPTZ,
     "createdAt" TIMESTAMPTZ NOT NULL,
     "updatedAt" TIMESTAMPTZ NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ux_affiliate_conversion_order" ON "AffiliateConversion" ("orderId")`,
  `CREATE INDEX IF NOT EXISTS "ix_affiliate_conversion_link_paid" ON "AffiliateConversion" ("linkCode", "paidAt" DESC, "id" DESC)`,
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
      `DROP TABLE IF EXISTS "AffiliateConversion"`,
    );
  },
};
