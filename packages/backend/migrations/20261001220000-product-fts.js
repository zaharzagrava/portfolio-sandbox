'use strict';

/**
 * SD-37: shop-admin product search on Postgres (lesson 03/01 §9 "when Postgres
 * is enough"): a shop searches its own few thousand products - a GIN full-text
 * index plus trigram similarity is plenty and stays transactionally fresh
 * (no ES lag right after an edit).
 *
 * The tsvector is maintained by a trigger rather than a STORED generated
 * column: adding a stored generated column rewrites the whole table under an
 * exclusive lock; a nullable column + trigger + batched backfill doesn't.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      SET lock_timeout = '5s';
      ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "searchVector" tsvector NULL;

      CREATE OR REPLACE FUNCTION product_search_vector() RETURNS trigger AS $$
      BEGIN
        NEW."searchVector" :=
          setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(NEW.brand, '')), 'B') ||
          setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'C');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS product_search_vector_trg ON "Product";
      CREATE TRIGGER product_search_vector_trg BEFORE INSERT OR UPDATE OF title, brand, description ON "Product"
        FOR EACH ROW EXECUTE FUNCTION product_search_vector();
    `);

    // Batched backfill: short transactions, no long row locks.
    for (;;) {
      const [, meta] = await queryInterface.sequelize.query(`
        UPDATE "Product" SET title = title
        WHERE id IN (SELECT id FROM "Product" WHERE "searchVector" IS NULL LIMIT 5000)
      `);
      if (!meta || meta.rowCount === 0) break;
    }

    await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Product_search_vector_gin" ON "Product" USING gin ("searchVector")`);
    await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "Product_title_trgm" ON "Product" USING gin (title gin_trgm_ops)`);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Product_title_trgm";
      DROP INDEX IF EXISTS "Product_search_vector_gin";
      DROP TRIGGER IF EXISTS product_search_vector_trg ON "Product";
      DROP FUNCTION IF EXISTS product_search_vector();
      ALTER TABLE "Product" DROP COLUMN IF EXISTS "searchVector";
    `);
  },
};
