'use strict';

/**
 * S20 same-day courier delivery, contract step (III.11, IX.4, D-12). Shipped for a LATER release and kept in this
 * subfolder, so `db:migrate` (and `db:jest:migrate:up`, which read `migrations/` without recursion) do not run it with the
 * expand step `20261017100000-delivery-s20-expand.js`. Run it by hand (`npx sequelize-cli db:migrate --migrations-path
 * migrations/contract`) only after the draft readers and writers are gone: nothing reads `feeCents`, `offeredCourierId`
 * or `offerExpiresAt`, nothing inserts a delivery without `orderId`, `feeMinor` and `currency`, and nothing relies on
 * the cascade of "DeliveryEvent" or on a foreign key to another domain.
 *
 * It refuses to change anything while a legacy offer exists that has no offer record. Then, in one short transaction
 * with `SET LOCAL lock_timeout`:
 *  - drops the foreign keys `Courier.id -> User`, `Delivery.shopId -> Shop`, `Delivery.buyerId -> User` and the
 *    cascading `DeliveryEvent.deliveryId -> Delivery` (the history is append-only; shop deletion cancels deliveries
 *    through the `tenancy.shop_deleted` consumer);
 *  - backfills and requires `feeMinor` (from `feeCents`) and `orderId` (legacy rows without an order get their own id as
 *    a placeholder so the NOT NULL can hold), removes the default of `currency`, then drops `feeCents`,
 *    `offeredCourierId`, `offerExpiresAt` and the redundant non-unique index `Delivery_courier_active_idx`.
 * Idempotent.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

async function assertSafe(q) {
  const [[check]] = await q(`
    SELECT count(*)::text AS "orphanOffers"
      FROM "Delivery" d
     WHERE d."status" = 'OFFERED'
       AND NOT EXISTS (SELECT 1 FROM "DeliveryOffer" o WHERE o."deliveryId" = d."id" AND o."status" = 'OFFERED')
  `);
  if (check.orphanOffers !== '0')
    throw new Error(
      `${check.orphanOffers} OFFERED deliveries have no offer record: let the recovery job expire them first`,
    );
}

/** Drops every foreign key of `table` that points at `referenced` (names differ between environments). */
async function dropForeignKeys(q, table, referenced) {
  const [rows] = await q(
    `SELECT con.conname AS "name"
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_class r ON r.oid = con.confrelid
      WHERE con.contype = 'f' AND t.relname = '${table}' AND r.relname = '${referenced}'`,
  );
  for (const { name } of rows)
    await q(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`);
}

module.exports = {
  assertSafe,

  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await assertSafe(q);

      await dropForeignKeys(q, 'Courier', 'User');
      await dropForeignKeys(q, 'Delivery', 'Shop');
      await dropForeignKeys(q, 'Delivery', 'User');
      await dropForeignKeys(q, 'DeliveryEvent', 'Delivery');

      await q(`DO $$
               BEGIN
                 IF EXISTS (SELECT 1 FROM information_schema.columns
                             WHERE table_schema = current_schema() AND table_name = 'Delivery' AND column_name = 'feeCents') THEN
                   EXECUTE 'UPDATE "Delivery" SET "feeMinor" = "feeCents" WHERE "feeMinor" IS NULL';
                 END IF;
               END $$`);
      await q(`UPDATE "Delivery" SET "orderId" = "id" WHERE "orderId" IS NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "feeMinor" SET NOT NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "orderId" SET NOT NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "currency" DROP DEFAULT`);
      await q(`ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_feeMinor_check"`);
      await q(`ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_feeMinor_check" CHECK ("feeMinor" >= 0)`);
      await q(
        `ALTER TABLE "Delivery" DROP COLUMN IF EXISTS "feeCents", DROP COLUMN IF EXISTS "offeredCourierId", DROP COLUMN IF EXISTS "offerExpiresAt"`,
      );
      await q(`DROP INDEX IF EXISTS "Delivery_courier_active_idx"`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(
        `ALTER TABLE "Delivery"
           ADD COLUMN IF NOT EXISTS "feeCents" INTEGER NULL,
           ADD COLUMN IF NOT EXISTS "offeredCourierId" UUID NULL,
           ADD COLUMN IF NOT EXISTS "offerExpiresAt" TIMESTAMPTZ NULL`,
      );
      await q(`UPDATE "Delivery" SET "feeCents" = "feeMinor" WHERE "feeCents" IS NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "feeCents" SET NOT NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "currency" SET DEFAULT 'EUR'`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "orderId" DROP NOT NULL`);
      await q(`ALTER TABLE "Delivery" ALTER COLUMN "feeMinor" DROP NOT NULL`);
      await q(`ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_feeMinor_check"`);
      await q(
        `CREATE INDEX IF NOT EXISTS "Delivery_courier_active_idx" ON "Delivery" ("courierId") WHERE "status" IN ('ASSIGNED', 'PICKED_UP')`,
      );
      // Foreign keys come back unvalidated: rows written after the contract step may point at deleted users or shops.
      await q(`ALTER TABLE "Courier" DROP CONSTRAINT IF EXISTS "Courier_id_fkey"`);
      await q(`ALTER TABLE "Courier" ADD CONSTRAINT "Courier_id_fkey" FOREIGN KEY ("id") REFERENCES "User"("id") ON DELETE CASCADE NOT VALID`);
      await q(`ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_shopId_fkey"`);
      await q(`ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") NOT VALID`);
      await q(`ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_buyerId_fkey"`);
      await q(`ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") NOT VALID`);
      await q(`ALTER TABLE "DeliveryEvent" DROP CONSTRAINT IF EXISTS "DeliveryEvent_deliveryId_fkey"`);
      await q(`ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE NOT VALID`);
    });
  },
};
