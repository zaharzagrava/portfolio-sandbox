'use strict';

/**
 * S05 catalog, contract step 2: "Product"."shopId" is NOT NULL. Refuses to run while the shop-id backfill has not
 * finished. The constraint goes in unvalidated, is validated without blocking writers, and only then becomes
 * NOT NULL (Postgres uses the validated check to skip the table scan). The checks added unvalidated by the expand
 * step ("quantity", "version") are validated here too. Each step has its own lock timeout.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const step = async (sql) => {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '3s'`, { transaction });
        await sequelize.query(sql, { transaction });
      });
    };

    const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM "Product" WHERE "shopId" IS NULL`);
    if (n > 0)
      throw new Error(
        `${n} products still have no shopId: let the job products.backfill-shop-ids finish, then deploy this step`,
      );

    await step(`ALTER TABLE "Product" DROP CONSTRAINT IF EXISTS "Product_shopId_not_null_tmp"`);
    await step(`ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_not_null_tmp" CHECK ("shopId" IS NOT NULL) NOT VALID`);
    await sequelize.query(`ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_shopId_not_null_tmp"`);
    await step(`ALTER TABLE "Product" ALTER COLUMN "shopId" SET NOT NULL`);
    await step(`ALTER TABLE "Product" DROP CONSTRAINT "Product_shopId_not_null_tmp"`);
    // Only the old S03 CHECK of this name. On PostgreSQL 18 the NOT NULL itself is a constraint with the same default
    // name, so an unconditional DROP CONSTRAINT here silently undid the SET NOT NULL above (fixed again by 20261019000200).
    await step(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Product"'::regclass AND conname = 'Product_shopId_not_null' AND contype = 'c') THEN
           ALTER TABLE "Product" DROP CONSTRAINT "Product_shopId_not_null";
         END IF;
       END $$`,
    );
    for (const check of ['Product_quantity_check', 'Product_version_check'])
      await sequelize.query(
        `DO $$ BEGIN
           IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${check}' AND NOT convalidated) THEN
             ALTER TABLE "Product" VALIDATE CONSTRAINT "${check}";
           END IF;
         END $$`,
      );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Product" ALTER COLUMN "shopId" DROP NOT NULL`);
  },
};
