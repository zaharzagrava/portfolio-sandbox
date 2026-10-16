'use strict';

/**
 * S31 asset library, contract step (III.11, IX.4; specs/domains/S31-assets-digital-delivery/gaps.md B1, section C):
 * no foreign key leaves the domain (`Asset.shopId → Shop`, `DigitalProduct.productId → Product`), the share link no
 * longer cascades from the asset (purge removes links explicitly, FR-029), and the old `deleted` flag is replaced by
 * `status`. Idempotent; constraint names are looked up, not assumed.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const DROP_FOREIGN_KEYS = `
  DO $$
  DECLARE fk RECORD;
  BEGIN
    FOR fk IN
      SELECT c.conname, c.conrelid::regclass AS tbl
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND (
           (c.conrelid = '"Asset"'::regclass AND c.confrelid = '"Shop"'::regclass)
        OR (c.conrelid = '"DigitalProduct"'::regclass AND c.confrelid = '"Product"'::regclass)
        OR (c.conrelid = '"AssetShareLink"'::regclass AND c.confrelid = '"Asset"'::regclass)
        OR (c.conrelid = '"DigitalProduct"'::regclass AND c.confrelid = '"Asset"'::regclass)
         )
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    END LOOP;
  END $$`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(LOCK_TIMEOUT, { transaction });
      await queryInterface.sequelize.query(DROP_FOREIGN_KEYS, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "Asset" DROP COLUMN IF EXISTS "deleted"`,
        { transaction },
      );
    });
  },

  async down() {
    // The dropped keys and column are not restored: the domain owns its identifiers (IX.4).
  },
};
