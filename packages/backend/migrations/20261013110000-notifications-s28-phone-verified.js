'use strict';

/**
 * S28 notifications, expand step 1 (III.11): "NotificationSettings"."phoneVerifiedAt" (nullable, no default, no rewrite).
 * A phone counts as verified only while this is set; the repository writes NULL in the same statement that changes
 * "phone" to another value. Existing phones stay unverified (no way to prove them), so SMS stays off until verified.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(
        `ALTER TABLE "NotificationSettings" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMPTZ NULL`,
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "NotificationSettings" DROP COLUMN IF EXISTS "phoneVerifiedAt"`,
    );
  },
};
