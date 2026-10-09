'use strict';

/**
 * S54 idempotency facility: one technical table owned by `infrastructure:idempotency` (IX.3) and the purge function.
 * Expand-only; no foreign keys (IX.4). `UNIQUE (scope, key)` is the atomic claim (III.6).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      SET LOCAL lock_timeout = '3s';
      CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
        "id" uuid PRIMARY KEY,
        "scope" varchar(160) NOT NULL,
        "key" varchar(128) NOT NULL,
        "fingerprint" char(64) NOT NULL,
        "state" varchar(16) NOT NULL CHECK ("state" IN ('in_flight', 'completed')),
        "claim_token" uuid NOT NULL,
        "lock_expires_at" timestamptz NOT NULL,
        "response_status" smallint NULL,
        "response_headers" jsonb NULL,
        "response_body" bytea NULL,
        "body_stored" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "IdempotencyKey_scope_key_uq" UNIQUE ("scope", "key")
      );
      CREATE INDEX IF NOT EXISTS "IdempotencyKey_expires_at_idx" ON "IdempotencyKey" ("expires_at");
    `);
    // Second additive step: the purge body. Deletes at most `batch` (never more than 1 000) rows whose retention (expiry + 1 h) is over.
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION purge_idempotency_keys(batch int, cutoff timestamptz DEFAULT now())
      RETURNS int LANGUAGE sql AS $$
        WITH doomed AS (
          SELECT "id" FROM "IdempotencyKey" WHERE "expires_at" <= cutoff - interval '1 hour' ORDER BY "expires_at" LIMIT least(batch, 1000)
        ), gone AS (
          DELETE FROM "IdempotencyKey" WHERE "id" IN (SELECT "id" FROM doomed) RETURNING 1
        )
        SELECT count(*)::int FROM gone
      $$;
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS purge_idempotency_keys(int, timestamptz);
      DROP TABLE IF EXISTS "IdempotencyKey";
    `);
  },
};
