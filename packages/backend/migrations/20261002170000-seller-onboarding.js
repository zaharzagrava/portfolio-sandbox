'use strict';

/**
 * SD-44 seller onboarding: submitted questionnaire, KYC documents, LLM
 * extractions (one row per attempt - cheap model, then escalation), and the
 * human review queue. Shops get a verification status; payouts stay off
 * until VERIFIED.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        SET LOCAL lock_timeout = '5s';
        ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED'
          CHECK ("verificationStatus" IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'));
        ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "payoutsEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

        CREATE TABLE IF NOT EXISTS "ShopOnboarding" (
          "shopId" UUID PRIMARY KEY REFERENCES "Shop"("id"),
          "answers" JSONB NOT NULL,
          "submittedBy" UUID NOT NULL,
          "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "verifiedAt" TIMESTAMPTZ NULL
        );

        CREATE TABLE IF NOT EXISTS "ShopDocument" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "shopId" UUID NOT NULL REFERENCES "Shop"("id"),
          "kind" TEXT NOT NULL CHECK ("kind" IN ('BUSINESS_REGISTRATION', 'VAT_CERTIFICATE', 'BANK_STATEMENT')),
          "contentType" TEXT NOT NULL,
          "contentHash" CHAR(64) NOT NULL,
          "storageKey" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'AWAITING_UPLOAD'
            CHECK ("status" IN ('AWAITING_UPLOAD', 'QUEUED', 'EXTRACTING', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
          "rejectionReason" TEXT NULL,
          "purgedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- The same file uploaded twice is the same document: one extraction (idempotency by content hash).
          UNIQUE ("shopId", "kind", "contentHash")
        );
        CREATE INDEX IF NOT EXISTS "ShopDocument_shop_kind" ON "ShopDocument" ("shopId", "kind", "createdAt" DESC);

        CREATE TABLE IF NOT EXISTS "DocumentExtraction" (
          "documentId" UUID NOT NULL REFERENCES "ShopDocument"("id"),
          "attempt" SMALLINT NOT NULL,
          "model" TEXT NOT NULL,
          "promptVersion" TEXT NOT NULL,
          -- Masked / non-sensitive view (safe to show and log); full values only inside sealedFields (AES-GCM, SecretBox).
          "fields" JSONB NOT NULL,
          "sealedFields" TEXT NOT NULL,
          "issues" JSONB NOT NULL,
          "outcome" TEXT NOT NULL CHECK ("outcome" IN ('ACCEPTED', 'ESCALATE', 'REVIEW')),
          "inputTokens" INTEGER NOT NULL,
          "outputTokens" INTEGER NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY ("documentId", "attempt")
        );

        CREATE TABLE IF NOT EXISTS "ReviewTask" (
          "id" UUID PRIMARY KEY DEFAULT uuidv7(),
          "documentId" UUID NOT NULL REFERENCES "ShopDocument"("id"),
          "shopId" UUID NOT NULL,
          "reasons" JSONB NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'APPROVED', 'REJECTED')),
          -- field → { extracted, corrected }: labelled data for the extraction eval set and per-field correction rates.
          "corrections" JSONB NULL,
          "resolvedBy" UUID NULL,
          "resolvedAt" TIMESTAMPTZ NULL,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "ReviewTask_one_open_per_document" ON "ReviewTask" ("documentId") WHERE "status" = 'OPEN';
        CREATE INDEX IF NOT EXISTS "ReviewTask_queue" ON "ReviewTask" ("createdAt") WHERE "status" = 'OPEN';
        `,
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS "ReviewTask", "DocumentExtraction", "ShopDocument", "ShopOnboarding";
      ALTER TABLE "Shop" DROP COLUMN IF EXISTS "verificationStatus", DROP COLUMN IF EXISTS "payoutsEnabled";
    `);
  },
};
