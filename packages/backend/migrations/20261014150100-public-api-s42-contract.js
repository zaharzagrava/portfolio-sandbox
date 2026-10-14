'use strict';

/**
 * S42 contract (data-model.md section 4, step 2): the capability owns its tables and keeps no foreign key into another
 * owner's table (IX.4). Drops `ApiKey.shopId -> Shop`, `ApiKey.createdBy -> User` and `ShopApiSettings.shopId -> Shop`;
 * constraint names are read from the catalog and dropped `IF EXISTS`. `Shop.sandboxOf` belongs to S03 and is untouched.
 *
 * `down` re-adds the constraints `NOT VALID` so that it cannot fail on rows written while they were absent.
 */
const FKS = [
  { table: 'ApiKey', column: 'shopId', target: '"Shop"("id")' },
  { table: 'ApiKey', column: 'createdBy', target: '"User"("id")' },
  { table: 'ShopApiSettings', column: 'shopId', target: '"Shop"("id")' },
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, options = {}) =>
        queryInterface.sequelize.query(sql, { transaction, ...options });
      await q(`SET LOCAL lock_timeout = '3s'`);
      for (const { table, column } of FKS) {
        const [rows] = await q(
          `SELECT con.conname
             FROM pg_constraint con
             JOIN pg_class rel ON rel.oid = con.conrelid
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
            WHERE con.contype = 'f' AND rel.relname = '${table}' AND att.attname = '${column}'`,
        );
        for (const { conname } of rows) {
          await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${conname}"`);
        }
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`SET LOCAL lock_timeout = '3s'`);
      for (const { table, column, target } of FKS) {
        const name = `${table}_${column}_fkey`;
        await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
        await q(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES ${target} NOT VALID`,
        );
      }
    });
  },
};
