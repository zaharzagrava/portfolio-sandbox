'use strict';

/**
 * S21 (S10 amendment): "StockReservation"."source" also accepts 'EXTERNAL', the units of an order whose stock is held
 * by another capability (an auction's unit). Data-neutral: the new check admits every value the old one did, so the
 * rows are not rescanned for correctness, only validated afterwards (the scan takes only a SHARE UPDATE EXCLUSIVE lock).
 * `down` restores the old check and must run only on a throwaway database (an EXTERNAL row would violate it).
 */
const OLD_SOURCES = `'CATALOG','POSTGRES','FLASH'`;
const NEW_SOURCES = `'CATALOG','POSTGRES','FLASH','EXTERNAL'`;

const replaceCheck = async (queryInterface, sources) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const t = (sql) => queryInterface.sequelize.query(sql, { transaction });
    await t(`SET LOCAL lock_timeout = '3s'`);
    await t(
      `ALTER TABLE "StockReservation" DROP CONSTRAINT IF EXISTS "StockReservation_source_check"`,
    );
    await t(
      `ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_source_check" CHECK ("source" IN (${sources})) NOT VALID`,
    );
  });
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '3s'`, {
      transaction,
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "StockReservation" VALIDATE CONSTRAINT "StockReservation_source_check"`,
      { transaction },
    );
  });
};

module.exports = {
  async up(queryInterface) {
    await replaceCheck(queryInterface, NEW_SOURCES);
  },

  async down(queryInterface) {
    await replaceCheck(queryInterface, OLD_SOURCES);
  },
};
