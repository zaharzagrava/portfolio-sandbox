'use strict';

/**
 * SD-23 same-day courier delivery. Postgres = deliveries + their state history
 * (low rate, needs transactions). Live courier positions are in Redis GEO,
 * position history in DynamoDB `CourierTrack`.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "Courier" (
        "id" UUID PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
        "city" TEXT NOT NULL,
        "vehicle" TEXT NOT NULL CHECK ("vehicle" IN ('bike', 'scooter', 'car')),
        "status" TEXT NOT NULL DEFAULT 'OFFLINE' CHECK ("status" IN ('OFFLINE', 'AVAILABLE', 'BUSY')),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "Delivery" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
        "orderId" UUID NULL,
        "buyerId" UUID NOT NULL REFERENCES "User"("id"),
        "city" TEXT NOT NULL,
        "pickupLat" DOUBLE PRECISION NOT NULL, "pickupLng" DOUBLE PRECISION NOT NULL,
        "dropoffLat" DOUBLE PRECISION NOT NULL, "dropoffLng" DOUBLE PRECISION NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'REQUESTED' CHECK ("status" IN ('REQUESTED', 'OFFERED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED')),
        "courierId" UUID NULL REFERENCES "Courier"("id"),
        "offeredCourierId" UUID NULL,
        "offerExpiresAt" TIMESTAMPTZ NULL,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "feeCents" INTEGER NOT NULL,
        "surge" NUMERIC(4, 2) NOT NULL DEFAULT 1.0,
        "version" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "Delivery_open_city_idx" ON "Delivery" ("city", "createdAt") WHERE "status" IN ('REQUESTED', 'OFFERED');
      CREATE INDEX IF NOT EXISTS "Delivery_courier_active_idx" ON "Delivery" ("courierId") WHERE "status" IN ('ASSIGNED', 'PICKED_UP');
      CREATE INDEX IF NOT EXISTS "Delivery_buyer_idx" ON "Delivery" ("buyerId", "createdAt" DESC);

      CREATE TABLE IF NOT EXISTS "DeliveryEvent" (
        "id" UUID PRIMARY KEY DEFAULT uuidv7(),
        "deliveryId" UUID NOT NULL REFERENCES "Delivery"("id") ON DELETE CASCADE,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        "courierId" UUID NULL,
        "detail" TEXT NULL,
        "at" TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "DeliveryEvent_delivery_idx" ON "DeliveryEvent" ("deliveryId", "at");
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "DeliveryEvent", "Delivery", "Courier"`);
  },
};
