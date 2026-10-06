'use strict';

/**
 * SD-13 "available near me". PostGIS geography (meters on the spheroid) + GiST
 * index = exact radius queries for pickup points; shopper-facing search runs on
 * the Elasticsearch availability index fed from PickupStock changes (outbox).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "PickupPoint" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
          "name" TEXT NOT NULL,
          "address" TEXT NOT NULL,
          "location" geography(Point, 4326) NOT NULL,
          "openingHours" JSONB NOT NULL DEFAULT '{}',
          "active" BOOLEAN NOT NULL DEFAULT TRUE,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "PickupPoint_location_gist" ON "PickupPoint" USING gist ("location");
        CREATE INDEX IF NOT EXISTS "PickupPoint_shop_idx" ON "PickupPoint" ("shopId");

        CREATE TABLE IF NOT EXISTS "PickupStock" (
          "pickupPointId" UUID NOT NULL REFERENCES "PickupPoint"("id") ON DELETE CASCADE,
          "productId" UUID NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
          "quantity" INTEGER NOT NULL CHECK ("quantity" >= 0),
          "version" INTEGER NOT NULL DEFAULT 1,
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("pickupPointId", "productId")
        );
        CREATE INDEX IF NOT EXISTS "PickupStock_product_idx" ON "PickupStock" ("productId") WHERE "quantity" > 0;
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "PickupStock", "PickupPoint"`);
  },
};
