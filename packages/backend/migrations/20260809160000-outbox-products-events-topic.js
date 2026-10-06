'use strict';

/**
 * Adds 'products.events' to the Outbox topic enum so product-create can
 * notify through the same topic-agnostic mailman as payments.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_Outbox_topic" ADD VALUE IF NOT EXISTS 'products.events';`,
    );
  },

  async down() {
    // Postgres doesn't support removing a single enum value; a down migration
    // would require recreating the type. Left as a no-op — this is additive
    // and harmless to leave in place.
  },
};
