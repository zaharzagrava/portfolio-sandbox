'use strict';

/**
 * SD-21 launch events. Seats are positions 0..seatCount-1 in a fixed layout
 * (row = floor(i / seatsPerRow)); holds live in DynamoDB + Redis, only
 * CONFIRMED bookings reach Postgres - at most seatCount rows per event, no
 * matter how many millions of people tried.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "LaunchEvent" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
          "title" TEXT NOT NULL,
          "venue" TEXT NOT NULL,
          "startsAt" TIMESTAMPTZ NOT NULL,
          "salesOpenAt" TIMESTAMPTZ NOT NULL,
          "seatCount" INTEGER NOT NULL CHECK ("seatCount" BETWEEN 1 AND 100000),
          "seatsPerRow" INTEGER NOT NULL DEFAULT 20 CHECK ("seatsPerRow" > 0),
          "perUserLimit" INTEGER NOT NULL DEFAULT 2,
          "admissionRatePerSec" INTEGER NOT NULL DEFAULT 200,
          "status" TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK ("status" IN ('SCHEDULED','ON_SALE','SOLD_OUT','CLOSED')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS "Booking" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "eventId" UUID NOT NULL REFERENCES "LaunchEvent"("id"),
          "seat" INTEGER NOT NULL,
          "userId" UUID NOT NULL,
          "holdId" UUID NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK ("status" IN ('CONFIRMED','CANCELLED')),
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Final guard against double booking: one CONFIRMED booking per seat (partial unique index).
        CREATE UNIQUE INDEX IF NOT EXISTS "Booking_one_confirmed_per_seat" ON "Booking" ("eventId", "seat") WHERE "status" = 'CONFIRMED';
        -- Confirming the same hold twice (retries) creates nothing new.
        CREATE UNIQUE INDEX IF NOT EXISTS "Booking_hold_seat" ON "Booking" ("holdId", "seat");
        CREATE INDEX IF NOT EXISTS "Booking_user_idx" ON "Booking" ("userId", "createdAt" DESC);
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "Booking", "LaunchEvent"`);
  },
};
