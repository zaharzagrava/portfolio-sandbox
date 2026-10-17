'use strict';

/**
 * S41 needs one more plan entitlement key, `maxCompetitorWatches` (watches per shop, S41 FR-003), and S18 has not added
 * it yet: the closed key list of the database check (`billing_entitlements_valid`, S17) gets it, additively. The
 * function is replaced in place; existing plans stay valid. The plan table's own values are S18's to set.
 */
const KEYS = `'freeShipping','earlyAccessDrops','maxProducts','seats','auctions','apiCallsPerMonth','assistantTokensPerMonth','maxCompetitorWatches'`;
const PREVIOUS = `'freeShipping','earlyAccessDrops','maxProducts','seats','auctions','apiCallsPerMonth','assistantTokensPerMonth'`;

const fn = (keys) => `CREATE OR REPLACE FUNCTION billing_entitlements_valid(e jsonb) RETURNS boolean AS $fn$
       SELECT jsonb_typeof(e) = 'object' AND NOT EXISTS (
         SELECT 1 FROM jsonb_each(e) AS kv(k, v)
          WHERE k NOT IN (${keys})
             OR NOT (jsonb_typeof(v) = 'boolean' OR (jsonb_typeof(v) = 'number' AND (v #>> '{}')::numeric >= 0)))
     $fn$ LANGUAGE sql IMMUTABLE`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(fn(KEYS));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(fn(PREVIOUS));
  },
};
