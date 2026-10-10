'use strict';

/**
 * S13 payments, expand step 1 (III.11; reversible; additive for every legacy writer):
 *  - "Payment": orderId, currency, version, charge-attempt marks, customer-action fields, failure code, unknown-outcome
 *    schedule, refund schedule; checks added NOT VALID (the backfill migration validates the old rows).
 *  - idempotencyKey becomes nullable (legacy, never read again); the foreign key to "BisOrder" is dropped (D-11).
 */
const FAILURE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'declined_other',
  'provider_rejected',
  'provider_unavailable',
  'provider_canceled',
  'no_provider_record',
  'order_not_payable',
  'order_cancelled',
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await t(`SET LOCAL lock_timeout = '3s'`);
      await t(`
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "orderId" UUID NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'USD';
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "chargeAttemptedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "chargeAttempts" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "requiresAction" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "clientSecret" TEXT NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "paymentMethodToken" TEXT NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "failureCode" TEXT NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "nextResolveAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "resolveChecks" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "unknownSince" TIMESTAMPTZ NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "lastStuckAlertAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "refundRequestedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "refundNextAt" TIMESTAMPTZ NULL;

        ALTER TABLE "Payment" ALTER COLUMN "idempotencyKey" DROP NOT NULL;
        ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_bisOrderId_fkey";

        ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_amount_range_check";
        ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_range_check"
          CHECK ("amount" BETWEEN 1 AND 99999999) NOT VALID;
        ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_currency_check";
        ALTER TABLE "Payment" ADD CONSTRAINT "Payment_currency_check"
          CHECK ("currency" IN ('EUR','USD','GBP')) NOT VALID;
        ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_failureCode_check";
        ALTER TABLE "Payment" ADD CONSTRAINT "Payment_failureCode_check"
          CHECK ("failureCode" IS NULL OR "failureCode" IN (${FAILURE_CODES.map((c) => `'${c}'`).join(',')})) NOT VALID;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_failureCode_check";
      ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_currency_check";
      ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_amount_range_check";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "refundNextAt";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "refundRequestedAt";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "lastStuckAlertAt";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "unknownSince";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "resolveChecks";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "nextResolveAt";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "failureCode";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "paymentMethodToken";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "clientSecret";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "requiresAction";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "chargeAttempts";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "chargeAttemptedAt";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "version";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "currency";
      ALTER TABLE "Payment" DROP COLUMN IF EXISTS "orderId";
    `);
  },
};
