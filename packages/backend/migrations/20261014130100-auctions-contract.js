'use strict';

/**
 * S21 auctions, contract step. Drops the foreign key "Auction"."shopId" -> "Shop" (no foreign key across owners, IX.4),
 * the legacy money columns of "Auction" and the legacy columns of "Bid" (their data was copied by the expand step),
 * sets the NOT NULLs of the new columns and adds the one-live-auction-per-product partial unique index (FR-005). A
 * product with more than one live legacy auction stops the migration with a message (an operator decides which to
 * cancel); the index cannot be built over them. `down` recreates the legacy columns from the new ones and must run only
 * on a throwaway database.
 */
module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        DO $$ DECLARE dup INTEGER; BEGIN
          SELECT count(*) INTO dup FROM (
            SELECT "productId" FROM "Auction"
            WHERE "status" IN ('SCHEDULED','OPEN','CLOSED','SECOND_CHANCE')
            GROUP BY "productId" HAVING count(*) > 1
          ) d;
          IF dup > 0 THEN
            RAISE EXCEPTION 'auctions contract: % product(s) have more than one live auction; cancel the extra ones first', dup;
          END IF;
        END $$;

        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_shopId_fkey";

        ALTER TABLE "Auction" ALTER COLUMN "currency" SET NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "startingPriceMinor" SET NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "minIncrementMinor" SET NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "priceMinor" SET NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';

        ALTER TABLE "Auction" DROP COLUMN IF EXISTS "startingPrice";
        ALTER TABLE "Auction" DROP COLUMN IF EXISTS "minIncrement";
        ALTER TABLE "Auction" DROP COLUMN IF EXISTS "reservePrice";
        ALTER TABLE "Auction" DROP COLUMN IF EXISTS "currentPrice";
        ALTER TABLE "Auction" DROP COLUMN IF EXISTS "finalPrice";

        ALTER TABLE "Bid" ALTER COLUMN "bidderId" SET NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "maxAmountMinor" SET NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "priceAfterMinor" SET NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "sequence" SET NOT NULL;
        DROP INDEX IF EXISTS "Bid_auction_version_uq";
        DROP INDEX IF EXISTS "Bid_auction_version_idx";
        ALTER TABLE "Bid" DROP COLUMN IF EXISTS "userId";
        ALTER TABLE "Bid" DROP COLUMN IF EXISTS "maxAmount";
        ALTER TABLE "Bid" DROP COLUMN IF EXISTS "priceAfter";
        ALTER TABLE "Bid" DROP COLUMN IF EXISTS "version";
        ALTER TABLE "Bid" VALIDATE CONSTRAINT "Bid_outcome_check";

        CREATE UNIQUE INDEX IF NOT EXISTS "Auction_live_product_uq" ON "Auction" ("productId")
          WHERE "status" IN ('SCHEDULED','OPEN','CLOSED','SECOND_CHANCE');
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.query(`
      DROP INDEX IF EXISTS "Auction_live_product_uq";
      ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "userId" UUID NULL;
      ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "maxAmount" BIGINT NULL;
      ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "priceAfter" BIGINT NULL;
      ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "version" INTEGER NULL;
      UPDATE "Bid" SET "userId" = "bidderId", "maxAmount" = "maxAmountMinor", "priceAfter" = "priceAfterMinor", "version" = "sequence";
      ALTER TABLE "Bid" ALTER COLUMN "bidderId" DROP NOT NULL;
      ALTER TABLE "Bid" ALTER COLUMN "maxAmountMinor" DROP NOT NULL;
      ALTER TABLE "Bid" ALTER COLUMN "priceAfterMinor" DROP NOT NULL;
      ALTER TABLE "Bid" ALTER COLUMN "sequence" DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS "Bid_auction_version_idx" ON "Bid" ("auctionId", "version" DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS "Bid_auction_version_uq" ON "Bid" ("auctionId", "version", "createdAt");
      ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "startingPrice" BIGINT NULL;
      ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "minIncrement" BIGINT NULL;
      ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "reservePrice" BIGINT NULL;
      ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "currentPrice" BIGINT NULL;
      ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "finalPrice" BIGINT NULL;
      UPDATE "Auction" SET "startingPrice" = "startingPriceMinor", "minIncrement" = "minIncrementMinor",
        "reservePrice" = "reservePriceMinor", "currentPrice" = "priceMinor", "finalPrice" = "finalPriceMinor";
      ALTER TABLE "Auction" ALTER COLUMN "currency" DROP NOT NULL;
      ALTER TABLE "Auction" ALTER COLUMN "startingPriceMinor" DROP NOT NULL;
      ALTER TABLE "Auction" ALTER COLUMN "minIncrementMinor" DROP NOT NULL;
      ALTER TABLE "Auction" ALTER COLUMN "priceMinor" DROP NOT NULL;
      ALTER TABLE "Auction" ALTER COLUMN "status" SET DEFAULT 'OPEN';
    `);
  },
};
