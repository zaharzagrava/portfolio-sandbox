'use strict';

/**
 * S24 scheduled drop (data-model.md section 4, step 4): removes `ChatMessage_old`, kept after the swap as a way back.
 * It lives outside `migrations/` on purpose (sequelize-cli would run it with the next deploy); copy it into
 * `migrations/` on or after 2026-12-15 and only after one release without a chat error. It refuses to run earlier.
 */
const NOT_BEFORE = new Date('2026-12-15T00:00:00Z');

module.exports = {
  async up(queryInterface) {
    if (Date.now() < NOT_BEFORE.getTime()) {
      throw new Error('chat-s24-drop-old must not run before 2026-12-15');
    }
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "ChatMessage_old"`);
  },

  async down() {
    throw new Error('ChatMessage_old cannot be restored; restore it from a backup');
  },
};
