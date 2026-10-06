'use strict';

/**
 * SD-24 subscription billing. Prices are versioned and never edited in place
 * (a price change = a new Price row; existing subscribers keep theirs until
 * migrated). Invoices are idempotent per (subscription, period).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "Plan" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "code" TEXT NOT NULL UNIQUE,
          "name" TEXT NOT NULL,
          "audience" TEXT NOT NULL CHECK ("audience" IN ('BUYER','SHOP')),
          "entitlements" JSONB NOT NULL DEFAULT '{}',
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS "Price" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "planId" UUID NOT NULL REFERENCES "Plan"("id"),
          "interval" TEXT NOT NULL CHECK ("interval" IN ('MONTH','YEAR')),
          "unitAmount" BIGINT NOT NULL CHECK ("unitAmount" >= 0),
          "currency" TEXT NOT NULL DEFAULT 'EUR',
          "perSeat" BOOLEAN NOT NULL DEFAULT FALSE,
          "includedUsage" JSONB NOT NULL DEFAULT '{}',
          "overagePer1000" JSONB NOT NULL DEFAULT '{}',
          "active" BOOLEAN NOT NULL DEFAULT TRUE,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS "Subscription" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "subjectType" TEXT NOT NULL CHECK ("subjectType" IN ('USER','SHOP')),
          "subjectId" UUID NOT NULL,
          "priceId" UUID NOT NULL REFERENCES "Price"("id"),
          "status" TEXT NOT NULL CHECK ("status" IN ('TRIALING','ACTIVE','PAST_DUE','UNPAID','CANCELED')),
          "quantity" INTEGER NOT NULL DEFAULT 1 CHECK ("quantity" >= 1),
          "billingAnchorDay" INTEGER NOT NULL CHECK ("billingAnchorDay" BETWEEN 1 AND 31),
          "currentPeriodStart" TIMESTAMPTZ NOT NULL,
          "currentPeriodEnd" TIMESTAMPTZ NOT NULL,
          "trialEndsAt" TIMESTAMPTZ NULL,
          "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT FALSE,
          "paymentMethodRef" TEXT NULL,
          "version" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- One live subscription per subject.
        CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_one_live" ON "Subscription" ("subjectType", "subjectId") WHERE "status" <> 'CANCELED';
        -- Billing run: what's due?
        CREATE INDEX IF NOT EXISTS "Subscription_due_idx" ON "Subscription" ("currentPeriodEnd") WHERE "status" IN ('TRIALING','ACTIVE','PAST_DUE');

        CREATE TABLE IF NOT EXISTS "Invoice" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "subscriptionId" UUID NOT NULL REFERENCES "Subscription"("id"),
          "periodStart" TIMESTAMPTZ NOT NULL,
          "periodEnd" TIMESTAMPTZ NOT NULL,
          "kind" TEXT NOT NULL DEFAULT 'RENEWAL' CHECK ("kind" IN ('RENEWAL','PRORATION')),
          "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','PAID','VOID','UNCOLLECTIBLE')),
          "total" BIGINT NOT NULL,
          "currency" TEXT NOT NULL,
          "attempts" INTEGER NOT NULL DEFAULT 0,
          "nextAttemptAt" TIMESTAMPTZ NULL,
          "usageMeasuredAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE ("subscriptionId", "periodStart", "kind")
        );
        CREATE TABLE IF NOT EXISTS "InvoiceLine" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "invoiceId" UUID NOT NULL REFERENCES "Invoice"("id") ON DELETE CASCADE,
          "kind" TEXT NOT NULL,
          "description" TEXT NOT NULL,
          "quantity" BIGINT NOT NULL,
          "amount" BIGINT NOT NULL
        );

        INSERT INTO "Plan" (code, name, audience, entitlements) VALUES
          ('plus', 'Marketplace Plus', 'BUYER', '{"freeShipping": true, "earlyAccessDrops": true}'),
          ('starter', 'Starter', 'SHOP', '{"maxProducts": 100, "seats": 2, "auctions": false, "apiCallsPerMonth": 10000, "assistantTokensPerMonth": 0}'),
          ('pro', 'Pro', 'SHOP', '{"maxProducts": 10000, "seats": 20, "auctions": true, "apiCallsPerMonth": 1000000, "assistantTokensPerMonth": 2000000}')
        ON CONFLICT (code) DO NOTHING;

        INSERT INTO "Price" ("planId", interval, "unitAmount", "perSeat", "includedUsage", "overagePer1000")
        SELECT id, 'MONTH', 499, FALSE, '{}'::jsonb, '{}'::jsonb FROM "Plan" WHERE code = 'plus'
        UNION ALL SELECT id, 'YEAR', 4990, FALSE, '{}'::jsonb, '{}'::jsonb FROM "Plan" WHERE code = 'plus'
        UNION ALL SELECT id, 'MONTH', 1900, TRUE, '{"api.calls": 10000}'::jsonb, '{"api.calls": 50}'::jsonb FROM "Plan" WHERE code = 'starter'
        UNION ALL SELECT id, 'MONTH', 9900, TRUE, '{"api.calls": 1000000}'::jsonb, '{"api.calls": 20}'::jsonb FROM "Plan" WHERE code = 'pro';
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "InvoiceLine", "Invoice", "Subscription", "Price", "Plan"`);
  },
};
