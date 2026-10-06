'use strict';

/**
 * SD-31 experiments. Layers give mutual exclusion: experiments in the same
 * layer own disjoint bucket ranges of that layer's hash, so a user is in at
 * most one of them (e.g. two checkout experiments never overlap).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Experiment" (
        "key" TEXT PRIMARY KEY CHECK ("key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
        "description" TEXT NOT NULL DEFAULT '',
        "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'RUNNING', 'STOPPED')),
        "variants" JSONB NOT NULL,
        "layer" TEXT NOT NULL,
        "layerFrom" INTEGER NOT NULL CHECK ("layerFrom" >= 0 AND "layerFrom" < 10000),
        "layerTo" INTEGER NOT NULL CHECK ("layerTo" > "layerFrom" AND "layerTo" <= 10000),
        "metric" TEXT NOT NULL,
        "startedAt" TIMESTAMPTZ NULL,
        "stoppedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- No two RUNNING experiments of one layer may overlap their bucket ranges.
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      ALTER TABLE "Experiment" DROP CONSTRAINT IF EXISTS "Experiment_layer_no_overlap";
      ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_layer_no_overlap"
        EXCLUDE USING gist ("layer" WITH =, int4range("layerFrom", "layerTo") WITH &&) WHERE ("status" = 'RUNNING');
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "Experiment"`);
  },
};
