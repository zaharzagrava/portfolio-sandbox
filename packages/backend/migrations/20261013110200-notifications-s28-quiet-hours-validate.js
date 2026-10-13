'use strict';

/**
 * S28 notifications, expand step 3: VALIDATE the quiet-hours pair CHECK after the previous migration cleared the
 * half-set rows. VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock, so writes continue.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);
    await q(
      `ALTER TABLE "NotificationSettings" VALIDATE CONSTRAINT "NotificationSettings_quiet_pair_check"`,
    );
  },

  async down() {
    // A validated constraint stays valid; the previous migration drops it on its way down.
  },
};
