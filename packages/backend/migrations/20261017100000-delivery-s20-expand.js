'use strict';

/**
 * S20 same-day courier delivery, expand step (III.11; specs/domains/S20-courier-delivery/data-model.md). Additive and
 * idempotent: the draft code (`feeCents`, `offeredCourierId`, `offerExpiresAt`, nullable `orderId`) keeps working
 * until the services are rewritten. Every group runs in its own short transaction with `SET LOCAL lock_timeout`;
 * indexes are built outside any transaction, `CONCURRENTLY`, after the backfill and the resolution of violators.
 *
 *  - "Delivery": feeMinor BIGINT (backfilled from feeCents; NOT NULL arrives with the contract step), currency,
 *    nextActionAt (backfilled for open rows so the recovery job picks legacy deliveries up), cancelReason,
 *    orderSyncedStatus. `surge NUMERIC(4,2)` already exists. `orderId` stays nullable here: the draft request path still
 *    inserts NULL; the contract step backfills the legacy NULLs and sets NOT NULL (`migrations/contract/`).
 *  - "DeliveryEvent": actorKind, actorId (backfilled from courierId), version (backfilled per delivery), "from" nullable
 *    (the creation row has no previous status).
 *  - "Courier": city CHECK `^[a-z0-9-]{2,40}$`, validated only when no legacy row violates it.
 *  - New "DeliveryOffer" (durable offer records; unique partial indexes carry the one-live-offer invariant) and
 *    "DeliverableOrder" (the copy built from order events, R3). No foreign key to another domain (IX.4, D-12).
 *  - Plan risk (c): before the unique indexes exist, couriers with more than one active assignment and (order, shop)
 *    pairs with more than one non-cancelled delivery are resolved: the oldest (a DELIVERED one first) stays, the others
 *    become CANCELLED with a history row.
 *
 * The foreign keys to "User" and "Shop", the cascade on "DeliveryEvent", `feeCents` and the draft offer columns go in the
 * contract step, `migrations/contract/20261017100100-delivery-s20-contract.js`, which is NOT picked up by `db:migrate`.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const ACTOR_KINDS = `('courier', 'shop', 'system', 'order')`;

const GROUPS = [
  [
    `ALTER TABLE "Delivery"
       ADD COLUMN IF NOT EXISTS "feeMinor" BIGINT NULL,
       ADD COLUMN IF NOT EXISTS "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
       ADD COLUMN IF NOT EXISTS "nextActionAt" TIMESTAMPTZ NULL,
       ADD COLUMN IF NOT EXISTS "cancelReason" TEXT NULL,
       ADD COLUMN IF NOT EXISTS "orderSyncedStatus" TEXT NULL`,
    `UPDATE "Delivery" SET "feeMinor" = "feeCents" WHERE "feeMinor" IS NULL`,
    `UPDATE "Delivery" SET "nextActionAt" = COALESCE("offerExpiresAt", now())
      WHERE "status" IN ('REQUESTED', 'OFFERED') AND "nextActionAt" IS NULL`,
    `ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_orderSyncedStatus_check"`,
    `ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderSyncedStatus_check"
       CHECK ("orderSyncedStatus" IS NULL OR "orderSyncedStatus" IN ('ASSIGNED', 'PICKED_UP', 'DELIVERED'))`,
  ],
  [
    `ALTER TABLE "DeliveryEvent"
       ADD COLUMN IF NOT EXISTS "actorKind" TEXT NOT NULL DEFAULT 'system',
       ADD COLUMN IF NOT EXISTS "actorId" UUID NULL,
       ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "DeliveryEvent" ALTER COLUMN "from" DROP NOT NULL`,
    `UPDATE "DeliveryEvent" SET "actorKind" = 'courier', "actorId" = "courierId"
      WHERE "courierId" IS NOT NULL AND "actorId" IS NULL AND "actorKind" = 'system'`,
    // The draft wrote no creation row, so the first transition of a delivery moved it from version 1 to 2.
    `UPDATE "DeliveryEvent" e SET "version" = r."n" + 1
       FROM (SELECT "id", row_number() OVER (PARTITION BY "deliveryId" ORDER BY "at", "id") AS "n" FROM "DeliveryEvent") r
      WHERE r."id" = e."id" AND e."version" = 0`,
    `ALTER TABLE "DeliveryEvent" DROP CONSTRAINT IF EXISTS "DeliveryEvent_actorKind_check"`,
    `ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_actorKind_check" CHECK ("actorKind" IN ${ACTOR_KINDS})`,
  ],
  [
    `ALTER TABLE "Courier" DROP CONSTRAINT IF EXISTS "Courier_city_check"`,
    `ALTER TABLE "Courier" ADD CONSTRAINT "Courier_city_check" CHECK ("city" ~ '^[a-z0-9-]{2,40}$') NOT VALID`,
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM "Courier" WHERE "city" !~ '^[a-z0-9-]{2,40}$') THEN
         ALTER TABLE "Courier" VALIDATE CONSTRAINT "Courier_city_check";
       END IF;
     END $$`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "DeliveryOffer" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "deliveryId" UUID NOT NULL REFERENCES "Delivery"("id"),
       "courierId" UUID NOT NULL,
       "attempt" INTEGER NOT NULL CHECK ("attempt" >= 0),
       "status" TEXT NOT NULL CHECK ("status" IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
       "offeredAt" TIMESTAMPTZ NOT NULL,
       "expiresAt" TIMESTAMPTZ NOT NULL,
       "respondedAt" TIMESTAMPTZ NULL
     )`,
    // A courier holds at most one live offer; a courier is offered a delivery at most once, ever (permanent exclusion).
    `CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryOffer_courier_live_key" ON "DeliveryOffer" ("courierId") WHERE "status" = 'OFFERED'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryOffer_delivery_courier_key" ON "DeliveryOffer" ("deliveryId", "courierId")`,
    `CREATE INDEX IF NOT EXISTS "DeliveryOffer_live_expiry_idx" ON "DeliveryOffer" ("expiresAt") WHERE "status" = 'OFFERED'`,
    `CREATE TABLE IF NOT EXISTS "DeliverableOrder" (
       "orderId" UUID PRIMARY KEY,
       "buyerId" UUID NOT NULL,
       "shopIds" UUID[] NOT NULL DEFAULT '{}',
       "currency" CHAR(3) NULL,
       "status" TEXT NOT NULL CHECK ("status" IN ('PAID', 'CANCELLED')),
       "orderVersion" INTEGER NOT NULL CHECK ("orderVersion" > 0),
       "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
  [
    // Legacy offers that live only in the draft columns become offer records, so the new accept path finds them.
    `INSERT INTO "DeliveryOffer" ("deliveryId", "courierId", "attempt", "status", "offeredAt", "expiresAt")
       SELECT d."id", d."offeredCourierId", d."attempt", 'OFFERED',
              COALESCE(d."offerExpiresAt", now()) - interval '15 seconds', COALESCE(d."offerExpiresAt", now())
         FROM "Delivery" d
        WHERE d."status" = 'OFFERED' AND d."offeredCourierId" IS NOT NULL
       ON CONFLICT DO NOTHING`,
  ],
  [
    // Plan risk (c): resolve violators of the unique indexes below, keeping the oldest and cancelling the rest.
    `WITH ranked AS (
       SELECT "id", "status" AS "prev",
              row_number() OVER (PARTITION BY "courierId" ORDER BY "createdAt", "id") AS "rn"
         FROM "Delivery"
        WHERE "status" IN ('ASSIGNED', 'PICKED_UP') AND "courierId" IS NOT NULL
     ), victims AS (SELECT "id", "prev" FROM ranked WHERE "rn" > 1),
     updated AS (
       UPDATE "Delivery" d
          SET "status" = 'CANCELLED', "cancelReason" = 'migration_duplicate_assignment', "nextActionAt" = NULL,
              "version" = d."version" + 1, "updatedAt" = now()
         FROM victims v WHERE d."id" = v."id"
       RETURNING d."id", d."version"
     )
     INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "detail", "actorKind", "version")
       SELECT v."id", v."prev", 'CANCELLED', 'migration_duplicate_assignment', 'system', u."version"
         FROM victims v JOIN updated u ON u."id" = v."id"`,
    `WITH ranked AS (
       SELECT "id", "status" AS "prev",
              row_number() OVER (
                PARTITION BY "orderId", "shopId"
                ORDER BY ("status" = 'DELIVERED') DESC, "createdAt", "id"
              ) AS "rn"
         FROM "Delivery"
        WHERE "status" <> 'CANCELLED' AND "orderId" IS NOT NULL
     ), victims AS (SELECT "id", "prev" FROM ranked WHERE "rn" > 1),
     updated AS (
       UPDATE "Delivery" d
          SET "status" = 'CANCELLED', "cancelReason" = 'migration_duplicate_order_delivery', "nextActionAt" = NULL,
              "version" = d."version" + 1, "updatedAt" = now()
         FROM victims v WHERE d."id" = v."id"
       RETURNING d."id", d."version"
     )
     INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "detail", "actorKind", "version")
       SELECT v."id", v."prev", 'CANCELLED', 'migration_duplicate_order_delivery', 'system', u."version"
         FROM victims v JOIN updated u ON u."id" = v."id"`,
  ],
];

const INDEXES = [
  // One non-cancelled delivery per (order, shop): DELIVERED blocks a new one, CANCELLED frees it (R-6).
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Delivery_order_shop_open_key" ON "Delivery" ("orderId", "shopId") WHERE "status" <> 'CANCELLED'`,
  // One active assignment per courier (FR-016).
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Delivery_courier_active_key" ON "Delivery" ("courierId") WHERE "status" IN ('ASSIGNED', 'PICKED_UP')`,
  // Shop list keyset (createdAt desc, id desc) and the buyer-by-order read.
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Delivery_shop_list_idx" ON "Delivery" ("shopId", "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Delivery_order_buyer_idx" ON "Delivery" ("orderId", "buyerId")`,
  // The recovery job: overdue offers and retries.
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Delivery_next_action_idx" ON "Delivery" ("nextActionAt") WHERE "status" IN ('REQUESTED', 'OFFERED')`,
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const group of GROUPS) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of group) await sequelize.query(sql, { transaction });
      });
    }
    for (const sql of INDEXES) await sequelize.query(sql);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    for (const name of [
      'Delivery_next_action_idx',
      'Delivery_order_buyer_idx',
      'Delivery_shop_list_idx',
      'Delivery_courier_active_key',
      'Delivery_order_shop_open_key',
    ])
      await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(LOCK_TIMEOUT);
      await q(`DROP TABLE IF EXISTS "DeliverableOrder", "DeliveryOffer"`);
      await q(`ALTER TABLE "Courier" DROP CONSTRAINT IF EXISTS "Courier_city_check"`);
      await q(`ALTER TABLE "DeliveryEvent" DROP CONSTRAINT IF EXISTS "DeliveryEvent_actorKind_check"`);
      await q(
        `ALTER TABLE "DeliveryEvent" DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "actorId", DROP COLUMN IF EXISTS "actorKind"`,
      );
      await q(`ALTER TABLE "Delivery" DROP CONSTRAINT IF EXISTS "Delivery_orderSyncedStatus_check"`);
      await q(
        `ALTER TABLE "Delivery" DROP COLUMN IF EXISTS "orderSyncedStatus", DROP COLUMN IF EXISTS "cancelReason", DROP COLUMN IF EXISTS "nextActionAt", DROP COLUMN IF EXISTS "currency", DROP COLUMN IF EXISTS "feeMinor"`,
      );
    });
  },
};
