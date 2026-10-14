'use strict';

/**
 * S47 knowledge documents, contract step (research.md R-5, D-12, G51). Apply only after the code that stops relying on
 * what it removes is deployed (the expand and backfill steps are already in):
 *  1. Drops every foreign key of "KnowledgeDocument" (they point at the tenancy and catalog tables, owned by other
 *     domains: IX.4). Names are generated, so they are found in `pg_constraint`, never assumed. Documents of a deleted
 *     product or shop now go through the `catalog.product_deleted` / `tenancy.shop_deleted` consumers instead of the
 *     cascade. "KnowledgeChunk"."documentId" → "KnowledgeDocument" is inside the domain and stays.
 *  2. "KnowledgeChunk"."embeddingModel" becomes NOT NULL (the backfill filled every row, the code writes it on insert).
 *  3. Drops the legacy free-text "KnowledgeDocument"."error" column (replaced by "failureCode", never returned by the API).
 * There is no meaningful `down`: the dropped foreign keys were the debt being repaid. `down` restores the two columns'
 * old shape only, so a rollback of the code finds them.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        DO $$
        DECLARE fk record;
        BEGIN
          FOR fk IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = '"KnowledgeDocument"'::regclass AND contype = 'f'
          LOOP
            EXECUTE format('ALTER TABLE "KnowledgeDocument" DROP CONSTRAINT %I', fk.conname);
          END LOOP;
        END $$;

        ALTER TABLE "KnowledgeChunk" ALTER COLUMN "embeddingModel" SET NOT NULL;
        ALTER TABLE "KnowledgeDocument" DROP COLUMN IF EXISTS "error";
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        ALTER TABLE "KnowledgeDocument" ADD COLUMN IF NOT EXISTS "error" TEXT NULL;
        ALTER TABLE "KnowledgeChunk" ALTER COLUMN "embeddingModel" DROP NOT NULL;
        `,
        { transaction },
      );
    });
  },
};
