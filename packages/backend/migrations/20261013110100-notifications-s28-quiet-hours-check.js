'use strict';

/**
 * S28 notifications, expand step 2: quiet hours are set and cleared as a pair. The CHECK is added NOT VALID (guards
 * new writes at once, no table scan under the lock), then rows that have only one end are cleared in batches. The
 * batch loop is resumable and idempotent: a second run finds nothing to change. VALIDATE runs in the next migration.
 */
const BATCH = 1000;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(
        `ALTER TABLE "NotificationSettings" DROP CONSTRAINT IF EXISTS "NotificationSettings_quiet_pair_check"`,
      );
      await q(`
        ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_quiet_pair_check"
          CHECK (("quietStart" IS NULL) = ("quietEnd" IS NULL)) NOT VALID
      `);
    });

    let cleared = 0;
    for (;;) {
      const [, meta] = await sequelize.query(`
        UPDATE "NotificationSettings" SET "quietStart" = NULL, "quietEnd" = NULL, "updatedAt" = now()
        WHERE "userId" IN (
          SELECT "userId" FROM "NotificationSettings"
          WHERE ("quietStart" IS NULL) <> ("quietEnd" IS NULL)
          LIMIT ${BATCH}
        )
      `);
      const n = meta.rowCount ?? 0;
      cleared += n;
      if (n < BATCH) break;
    }
    if (cleared > 0)
      console.warn(
        `notifications-s28-quiet-hours: cleared ${cleared} settings rows that had only one end of the quiet window`,
      );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "NotificationSettings" DROP CONSTRAINT IF EXISTS "NotificationSettings_quiet_pair_check"`,
    );
  },
};
