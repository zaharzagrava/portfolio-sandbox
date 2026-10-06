'use strict';

/**
 * F-02: extensions used by SD-13 (PostGIS geography + GiST) and SD-43
 * (pgvector HNSW), plus btree_gist for exclusion constraints (SD-41
 * bitemporal rates). Requires the custom image in infra/docker/postgres.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    `);
  },

  async down(queryInterface) {
    // Extensions are left in place: dropping them would cascade to dependent columns/indexes.
    await queryInterface.sequelize.query('SELECT 1');
  },
};
