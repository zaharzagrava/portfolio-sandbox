'use strict';

/**
 * S22 booking, expand step (specs/domains/S22-booking/data-model.md). Additive and idempotent.
 *  - "LaunchEvent": seatingMode, humanCheckRequired, closedReason.
 *  - "LaunchEventHistory" and "BookingEvent": one row per state change (III.7).
 *  - "Booking": confirmedAt (backfilled from createdAt) and the two read indexes. The partial unique index
 *    "Booking_one_confirmed_per_seat" stays: it is the final guard against a double booking.
 * Indexes are built outside any transaction, CONCURRENTLY.
 */
const LOCK_TIMEOUT = `SET LOCAL lock_timeout = '5s'`;

const GROUPS = [
  [
    `ALTER TABLE "LaunchEvent"
       ADD COLUMN IF NOT EXISTS "seatingMode" TEXT NOT NULL DEFAULT 'SEATED',
       ADD COLUMN IF NOT EXISTS "humanCheckRequired" BOOLEAN NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS "closedReason" TEXT NULL`,
    `ALTER TABLE "LaunchEvent" DROP CONSTRAINT IF EXISTS "LaunchEvent_seatingMode_check"`,
    `ALTER TABLE "LaunchEvent" ADD CONSTRAINT "LaunchEvent_seatingMode_check" CHECK ("seatingMode" IN ('SEATED','GENERAL'))`,
    `ALTER TABLE "LaunchEvent" DROP CONSTRAINT IF EXISTS "LaunchEvent_closedReason_check"`,
    `ALTER TABLE "LaunchEvent" ADD CONSTRAINT "LaunchEvent_closedReason_check" CHECK ("closedReason" IS NULL OR "closedReason" IN ('organizer','started'))`,
    `ALTER TABLE "LaunchEvent" DROP CONSTRAINT IF EXISTS "LaunchEvent_perUserLimit_check"`,
    `ALTER TABLE "LaunchEvent" ADD CONSTRAINT "LaunchEvent_perUserLimit_check" CHECK ("perUserLimit" BETWEEN 1 AND 10) NOT VALID`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS "LaunchEventHistory" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "launchEventId" UUID NOT NULL,
       "fromStatus" TEXT NOT NULL,
       "toStatus" TEXT NOT NULL,
       "reason" TEXT NULL,
       "at" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS "BookingEvent" (
       "id" UUID PRIMARY KEY DEFAULT uuidv7(),
       "bookingId" UUID NOT NULL,
       "fromStatus" TEXT NULL,
       "toStatus" TEXT NOT NULL,
       "holdId" UUID NOT NULL,
       "at" TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
  [
    `ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMPTZ NULL`,
    `UPDATE "Booking" SET "confirmedAt" = "createdAt" WHERE "confirmedAt" IS NULL`,
    `ALTER TABLE "Booking" ALTER COLUMN "confirmedAt" SET DEFAULT now()`,
    `ALTER TABLE "Booking" ALTER COLUMN "confirmedAt" SET NOT NULL`,
  ],
];

const INDEXES = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "LaunchEventHistory_event_at_idx" ON "LaunchEventHistory" ("launchEventId", "at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "BookingEvent_booking_idx" ON "BookingEvent" ("bookingId", "at")`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Booking_event_confirmed_idx" ON "Booking" ("eventId", "confirmedAt" DESC, "id" DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Booking_event_user_idx" ON "Booking" ("eventId", "userId")`,
];

module.exports = {
  async up(queryInterface) {
    for (const group of GROUPS) {
      await queryInterface.sequelize.transaction(async (transaction) => {
        await queryInterface.sequelize.query(LOCK_TIMEOUT, { transaction });
        for (const sql of group) {
          await queryInterface.sequelize.query(sql, { transaction });
        }
      });
    }
    for (const sql of INDEXES) await queryInterface.sequelize.query(sql);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Booking_event_user_idx";
      DROP INDEX IF EXISTS "Booking_event_confirmed_idx";
      DROP TABLE IF EXISTS "BookingEvent";
      DROP TABLE IF EXISTS "LaunchEventHistory";
      ALTER TABLE "Booking" DROP COLUMN IF EXISTS "confirmedAt";
      ALTER TABLE "LaunchEvent" DROP CONSTRAINT IF EXISTS "LaunchEvent_perUserLimit_check",
        DROP COLUMN IF EXISTS "closedReason", DROP COLUMN IF EXISTS "humanCheckRequired", DROP COLUMN IF EXISTS "seatingMode";
    `);
  },
};
