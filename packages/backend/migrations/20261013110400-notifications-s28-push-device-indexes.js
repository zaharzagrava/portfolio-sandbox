'use strict';

/**
 * S28 notifications, expand step 5: indexes of "PushDevice", all CONCURRENTLY (so this migration runs outside any
 * transaction): the device id (unique, for `DELETE .../:deviceId`), (userId, tokenHash) and (userId, lastSeenAt) for
 * the 10-device cap eviction.
 */
const INDEXES = [
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "PushDevice_id_key" ON "PushDevice" ("id")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "PushDevice_user_tokenHash_idx" ON "PushDevice" ("userId", "tokenHash")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "PushDevice_user_lastSeen_idx" ON "PushDevice" ("userId", "lastSeenAt")`,
];

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`SET lock_timeout = '3s'`);
    for (const sql of INDEXES) await q(sql);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const name of [
      'PushDevice_user_lastSeen_idx',
      'PushDevice_user_tokenHash_idx',
      'PushDevice_id_key',
    ])
      await q(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
  },
};
