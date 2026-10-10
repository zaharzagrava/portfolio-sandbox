'use strict';

/**
 * S13 payments, expand step 3: "PaymentHistory" (append-only, one row per status move) and "PayableOrder" (the order
 * copy fed by orders.events, R3). No foreign keys: references to other owners are plain columns (IX.4).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        CREATE TABLE IF NOT EXISTS "PaymentHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "paymentId" UUID NOT NULL,
          "version" INTEGER NOT NULL,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "reason" TEXT NULL,
          "actor" TEXT NOT NULL,
          "at" TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "PaymentHistory_payment_version_key"
          ON "PaymentHistory" ("paymentId", "version");

        CREATE TABLE IF NOT EXISTS "PayableOrder" (
          "orderId" UUID PRIMARY KEY,
          "userId" TEXT NOT NULL,
          "totalMinor" BIGINT NULL,
          "currency" TEXT NULL,
          "status" TEXT NOT NULL CHECK ("status" IN ('RESERVED','PAID','CANCELLED')),
          "reservedUntil" TIMESTAMPTZ NULL,
          "orderVersion" INTEGER NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        );
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "PayableOrder";
      DROP TABLE IF EXISTS "PaymentHistory";
    `);
  },
};
