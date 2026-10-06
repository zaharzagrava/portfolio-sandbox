'use strict';

/**
 * SD-22 auctions. During an auction the authoritative live state is a Redis
 * hash mutated by one Lua script per bid; Postgres holds the auction record
 * and the append-only bid log (written in batches by the bid relay).
 * "Bid" is range-partitioned by month: append-only, huge, queried by recency.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "Auction" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
          "productId" UUID NOT NULL,
          "title" TEXT NOT NULL,
          "startingPrice" BIGINT NOT NULL CHECK ("startingPrice" > 0),
          "minIncrement" BIGINT NOT NULL CHECK ("minIncrement" > 0),
          "reservePrice" BIGINT NULL,
          "startsAt" TIMESTAMPTZ NOT NULL,
          "endsAt" TIMESTAMPTZ NOT NULL,
          "originalEndsAt" TIMESTAMPTZ NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','CLOSED','UNSOLD','CANCELLED')),
          "currentPrice" BIGINT NOT NULL,
          "leaderId" UUID NULL,
          "winnerId" UUID NULL,
          "finalPrice" BIGINT NULL,
          "bidCount" INTEGER NOT NULL DEFAULT 0,
          "version" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "Auction_open_ends_idx" ON "Auction" ("endsAt") WHERE "status" = 'OPEN';

        CREATE TABLE IF NOT EXISTS "Bid" (
          "id" UUID NOT NULL DEFAULT uuidv7(),
          "auctionId" UUID NOT NULL,
          "userId" UUID NOT NULL,
          "maxAmount" BIGINT NOT NULL,
          "outcome" TEXT NOT NULL,
          "priceAfter" BIGINT NOT NULL,
          "version" INTEGER NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("id", "createdAt")
        ) PARTITION BY RANGE ("createdAt");
        CREATE TABLE IF NOT EXISTS "Bid_default" PARTITION OF "Bid" DEFAULT;
        CREATE INDEX IF NOT EXISTS "Bid_auction_version_idx" ON "Bid" ("auctionId", "version" DESC);
        -- Relay retries must not duplicate a bid: one row per (auction, version) - version is assigned by the Lua script.
        CREATE UNIQUE INDEX IF NOT EXISTS "Bid_auction_version_uq" ON "Bid" ("auctionId", "version", "createdAt");

        CREATE OR REPLACE FUNCTION bid_ensure_partitions(from_month DATE, months INT) RETURNS VOID AS $$
        DECLARE m DATE; name TEXT;
        BEGIN
          FOR i IN 0..months - 1 LOOP
            m := (date_trunc('month', from_month) + make_interval(months => i))::date;
            name := 'Bid_' || to_char(m, 'YYYYMM');
            IF to_regclass(format('%I', name)) IS NULL THEN
              EXECUTE format('CREATE TABLE %I PARTITION OF "Bid" FOR VALUES FROM (%L) TO (%L)', name, m, (m + interval '1 month')::date);
            END IF;
          END LOOP;
        END;
        $$ LANGUAGE plpgsql;
        SELECT bid_ensure_partitions(now()::date, 4);
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "Bid" CASCADE; DROP TABLE IF EXISTS "Auction"; DROP FUNCTION IF EXISTS bid_ensure_partitions(DATE, INT);`);
  },
};
