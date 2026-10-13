'use strict';

/**
 * S19 pickup, contract step (III.11, IX.4): drops the foreign keys from the pickup tables to other domains' tables,
 * `PickupPoint.shopId -> Shop` and `PickupStock.productId -> Product` (both with ON DELETE CASCADE). They stay plain
 * ID columns; shop deletion deactivates the points and product deletion removes the stock rows through events
 * (consumers of `tenancy.shop_deleted` and `catalog.product_deleted`). Its own file: it runs only after the code no
 * longer relies on the cascade.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      await q(`
        DO $$
        DECLARE fk record;
        BEGIN
          FOR fk IN
            SELECT conrelid::regclass AS tbl, conname
              FROM pg_constraint
             WHERE contype = 'f'
               AND ((conrelid = '"PickupPoint"'::regclass AND confrelid = '"Shop"'::regclass)
                 OR (conrelid = '"PickupStock"'::regclass AND confrelid = '"Product"'::regclass))
          LOOP
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
          END LOOP;
        END $$;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(
        `ALTER TABLE "PickupPoint" ADD CONSTRAINT "PickupPoint_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`,
      );
      await q(
        `ALTER TABLE "PickupStock" ADD CONSTRAINT "PickupStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE NOT VALID`,
      );
    });
  },
};
