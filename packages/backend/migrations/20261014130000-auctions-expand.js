'use strict';

/**
 * S21 auctions, expand step (data-model §1-3). "Auction": currency, leaderMaxMinor, unitHeld, holdRequestedAt,
 * returnPending, firstOrderId, winnerOrderId, settlementOrderVersion, offerExpiresAt, closedAt, statusReason and the
 * "...Minor" money columns (copied from the legacy ones in batches of 1,000); the status CHECK is widened to the seven
 * statuses. "Bid": bidderId, maxAmountMinor, priceAfterMinor, sequence (copied the same way). New append-only
 * "AuctionHistory". The indexes of the new access paths. The contract step (20261014130100) drops the legacy columns
 * and the foreign key to "Shop" and adds the NOT NULLs and the one-live-auction-per-product index. Idempotent; every
 * statement runs under a 5 s lock_timeout. `down` is for a throwaway database only.
 */

const BATCH = 1000;

const STATUSES = `'SCHEDULED','OPEN','CLOSED','SECOND_CHANCE','SOLD','UNSOLD','CANCELLED'`;
const REASONS = `'no_bids','reserve_not_met','leader_ineligible','winner_unpaid','second_chance_unpaid','seller_cancelled','stock_hold_failed'`;

/** Runs `sql` (which must update at most BATCH rows) until it touches none. */
const inBatches = async (sequelize, sql) => {
  for (;;) {
    const [, meta] = await sequelize.query(sql);
    const touched = typeof meta === 'number' ? meta : (meta?.rowCount ?? 0);
    if (touched < BATCH) return;
  }
};

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        CREATE TABLE IF NOT EXISTS "AuctionHistory" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "auctionId" UUID NOT NULL,
          "fromStatus" TEXT NULL,
          "toStatus" TEXT NOT NULL,
          "reason" TEXT NULL,
          "auctionVersion" INTEGER NOT NULL,
          "at" TIMESTAMPTZ NOT NULL,
          "actor" TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "AuctionHistory_auction_at_idx" ON "AuctionHistory" ("auctionId", "at", "id");

        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "currency" TEXT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "startingPriceMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "minIncrementMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "reservePriceMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "priceMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "finalPriceMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "leaderMaxMinor" BIGINT NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "unitHeld" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "holdRequestedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "returnPending" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "firstOrderId" UUID NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "winnerOrderId" UUID NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "settlementOrderVersion" INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "offerExpiresAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMPTZ NULL;
        ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "statusReason" TEXT NULL;

        -- the legacy columns are dropped by the contract step; until then they must not block new inserts
        ALTER TABLE "Auction" ALTER COLUMN "startingPrice" DROP NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "minIncrement" DROP NOT NULL;
        ALTER TABLE "Auction" ALTER COLUMN "currentPrice" DROP NOT NULL;

        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_status_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_status_check" CHECK ("status" IN (${STATUSES}));
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_statusReason_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_statusReason_check"
          CHECK ("statusReason" IS NULL OR "statusReason" IN (${REASONS}));

        ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "bidderId" UUID NULL;
        ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "maxAmountMinor" BIGINT NULL;
        ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "priceAfterMinor" BIGINT NULL;
        ALTER TABLE "Bid" ADD COLUMN IF NOT EXISTS "sequence" INTEGER NULL;
        ALTER TABLE "Bid" ALTER COLUMN "userId" DROP NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "maxAmount" DROP NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "priceAfter" DROP NOT NULL;
        ALTER TABLE "Bid" ALTER COLUMN "version" DROP NOT NULL;
        `,
        { transaction },
      );
    });

    // copy the legacy columns in batches of 1,000 (the tables are empty or small in practice)
    await inBatches(
      sequelize,
      `UPDATE "Auction" SET
         "startingPriceMinor" = "startingPrice", "minIncrementMinor" = "minIncrement", "reservePriceMinor" = "reservePrice",
         "priceMinor" = "currentPrice", "finalPriceMinor" = "finalPrice"
       WHERE "id" IN (SELECT "id" FROM "Auction" WHERE "startingPriceMinor" IS NULL
         AND "startingPrice" IS NOT NULL LIMIT ${BATCH})`,
    );
    await inBatches(
      sequelize,
      `UPDATE "Bid" SET
         "bidderId" = "userId", "maxAmountMinor" = "maxAmount", "priceAfterMinor" = "priceAfter", "sequence" = "version"
       WHERE ("id", "createdAt") IN (SELECT "id", "createdAt" FROM "Bid" WHERE "bidderId" IS NULL
         AND "userId" IS NOT NULL LIMIT ${BATCH})`,
    );

    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';

        -- one-off data fix: the auction currency is the product currency at scheduling (migration-only read of "Product")
        UPDATE "Auction" a SET "currency" = p."currency" FROM "Product" p WHERE p."id" = a."productId" AND a."currency" IS NULL;
        UPDATE "Auction" SET "currency" = 'EUR' WHERE "currency" IS NULL;
        UPDATE "Auction" SET "title" = left("title", 140) WHERE length("title") > 140;

        -- a legacy OPEN auction's unit already left stock through the old raw update; its leader's maximum is the newest bid's
        UPDATE "Auction" SET "unitHeld" = true WHERE "status" = 'OPEN' AND "unitHeld" = false;
        UPDATE "Auction" a SET "leaderMaxMinor" = b."maxAmountMinor"
        FROM (
          SELECT DISTINCT ON ("auctionId") "auctionId", "maxAmountMinor" FROM "Bid"
          ORDER BY "auctionId", "createdAt" DESC, "sequence" DESC
        ) b
        WHERE b."auctionId" = a."id" AND a."leaderId" IS NOT NULL AND a."leaderMaxMinor" IS NULL;
        UPDATE "Auction" SET "closedAt" = "endsAt" WHERE "status" IN ('CLOSED','UNSOLD') AND "closedAt" IS NULL;

        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_currency_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$') NOT VALID;
        ALTER TABLE "Auction" VALIDATE CONSTRAINT "Auction_currency_check";
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_title_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_title_check" CHECK (char_length("title") BETWEEN 1 AND 140) NOT VALID;
        ALTER TABLE "Auction" VALIDATE CONSTRAINT "Auction_title_check";
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_bidCount_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_bidCount_check" CHECK ("bidCount" >= 0) NOT VALID;
        ALTER TABLE "Auction" VALIDATE CONSTRAINT "Auction_bidCount_check";
        -- legacy rows were never checked against these three: they bind every new and updated row, old rows are left as they are
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_reserve_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_reserve_check"
          CHECK ("reservePriceMinor" IS NULL OR "reservePriceMinor" >= "startingPriceMinor") NOT VALID;
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_window_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_window_check" CHECK ("endsAt" > "startsAt") NOT VALID;
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_original_end_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_original_end_check" CHECK ("originalEndsAt" <= "endsAt") NOT VALID;
        ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_amounts_check";
        ALTER TABLE "Auction" ADD CONSTRAINT "Auction_amounts_check"
          CHECK ("startingPriceMinor" > 0 AND "minIncrementMinor" > 0) NOT VALID;

        ALTER TABLE "Bid" DROP CONSTRAINT IF EXISTS "Bid_outcome_check";
        ALTER TABLE "Bid" ADD CONSTRAINT "Bid_outcome_check" CHECK ("outcome" IN ('leading','outbid','raised')) NOT VALID;

        CREATE INDEX IF NOT EXISTS "Auction_shop_list_idx" ON "Auction" ("shopId", "startsAt" DESC, "id" DESC);
        CREATE INDEX IF NOT EXISTS "Auction_winner_order_idx" ON "Auction" ("winnerOrderId") WHERE "winnerOrderId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "Auction_first_order_idx" ON "Auction" ("firstOrderId") WHERE "firstOrderId" IS NOT NULL;
        CREATE INDEX IF NOT EXISTS "Auction_hold_pending_idx" ON "Auction" ("holdRequestedAt")
          WHERE "unitHeld" = false AND "status" = 'SCHEDULED';
        CREATE INDEX IF NOT EXISTS "Auction_return_pending_idx" ON "Auction" ("id") WHERE "returnPending";
        CREATE INDEX IF NOT EXISTS "Auction_product_idx" ON "Auction" ("productId", "startsAt" DESC);
        CREATE INDEX IF NOT EXISTS "Bid_auction_sequence_idx" ON "Bid" ("auctionId", "sequence" DESC);
        CREATE INDEX IF NOT EXISTS "Bid_auction_bidder_idx" ON "Bid" ("auctionId", "bidderId", "sequence" DESC);
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.query(`
      DROP INDEX IF EXISTS "Bid_auction_bidder_idx";
      DROP INDEX IF EXISTS "Bid_auction_sequence_idx";
      DROP INDEX IF EXISTS "Auction_product_idx";
      DROP INDEX IF EXISTS "Auction_return_pending_idx";
      DROP INDEX IF EXISTS "Auction_hold_pending_idx";
      DROP INDEX IF EXISTS "Auction_first_order_idx";
      DROP INDEX IF EXISTS "Auction_winner_order_idx";
      DROP INDEX IF EXISTS "Auction_shop_list_idx";
      ALTER TABLE "Bid" DROP CONSTRAINT IF EXISTS "Bid_outcome_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_amounts_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_original_end_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_window_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_reserve_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_bidCount_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_title_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_currency_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_statusReason_check";
      ALTER TABLE "Auction" DROP CONSTRAINT IF EXISTS "Auction_status_check";
      ALTER TABLE "Auction" ADD CONSTRAINT "Auction_status_check" CHECK ("status" IN ('OPEN','CLOSED','UNSOLD','CANCELLED'));
      ALTER TABLE "Bid" DROP COLUMN IF EXISTS "sequence";
      ALTER TABLE "Bid" DROP COLUMN IF EXISTS "priceAfterMinor";
      ALTER TABLE "Bid" DROP COLUMN IF EXISTS "maxAmountMinor";
      ALTER TABLE "Bid" DROP COLUMN IF EXISTS "bidderId";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "statusReason";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "closedAt";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "offerExpiresAt";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "settlementOrderVersion";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "winnerOrderId";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "firstOrderId";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "returnPending";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "holdRequestedAt";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "unitHeld";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "leaderMaxMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "finalPriceMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "priceMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "reservePriceMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "minIncrementMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "startingPriceMinor";
      ALTER TABLE "Auction" DROP COLUMN IF EXISTS "currency";
      DROP TABLE IF EXISTS "AuctionHistory";
    `);
  },
};
