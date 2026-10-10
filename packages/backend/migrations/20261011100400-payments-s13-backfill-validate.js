'use strict';

/**
 * S13 payments, expand step 5: backfill and validate.
 *  - orderId = bisOrderId; when an order has several payments only the earliest row gets the reference (the unique
 *    index allows one), the others keep NULL and are counted in the migration log.
 *  - one synthetic history row per payment that has none.
 *  - VALIDATE the checks added NOT VALID; rows outside the amount range are reported and the check stays NOT VALID
 *    (it still guards new rows) instead of rewriting money.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);

    await q(`
      UPDATE "Payment" p SET "orderId" = p."bisOrderId"
      WHERE p."orderId" IS NULL
        AND p."id" = (
          SELECT p2."id" FROM "Payment" p2 WHERE p2."bisOrderId" = p."bisOrderId" ORDER BY p2."createdAt", p2."id" LIMIT 1
        )
    `);
    const [[dupes]] = await q(
      `SELECT count(*)::int AS n FROM "Payment" WHERE "orderId" IS NULL`,
    );
    if (dupes.n > 0)
      console.warn(
        `payments-s13-backfill: ${dupes.n} legacy payments share an order with an earlier payment; their orderId stays NULL`,
      );

    await q(`
      INSERT INTO "PaymentHistory" ("paymentId", "version", "fromStatus", "toStatus", "reason", "actor", "at")
      SELECT p."id", 1, NULL, p."status"::text, 'backfill', 'system:migration', p."createdAt"
      FROM "Payment" p
      WHERE NOT EXISTS (SELECT 1 FROM "PaymentHistory" h WHERE h."paymentId" = p."id")
    `);

    await q(`ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_currency_check"`);
    await q(
      `ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_failureCode_check"`,
    );
    const [[bad]] = await q(
      `SELECT count(*)::int AS n FROM "Payment" WHERE "amount" NOT BETWEEN 1 AND 99999999`,
    );
    if (bad.n > 0)
      console.warn(
        `payments-s13-backfill: ${bad.n} legacy payments have an amount outside 1..99999999; Payment_amount_range_check stays NOT VALID`,
      );
    else
      await q(
        `ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_amount_range_check"`,
      );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM "PaymentHistory" WHERE "actor" = 'system:migration'`,
    );
  },
};
