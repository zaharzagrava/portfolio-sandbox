import { v4 as uuidv4 } from 'uuid';
import type { BillingTestApp } from './billing-app';

/**
 * Privileged setup for the S18 specs (test-plan.md: "S17's real SubscriptionBasisService over seeded subscriptions"):
 * a subscription row written directly, so a spec reaches a status, a version or a plan without running the payment
 * flows of S17. Reads and the code under test never use this.
 */
export interface SeededSubscription {
  id: string;
  priceId: string;
}

export async function seedSubscription(
  t: BillingTestApp,
  input: {
    subjectType: 'SHOP' | 'USER';
    subjectId: string;
    plan: 'starter' | 'pro' | 'plus';
    status?: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';
    version?: number;
    periodStart?: string;
    periodEnd?: string;
  },
): Promise<SeededSubscription> {
  const id = uuidv4();
  const priceId = await t.priceId(input.plan);
  await t.sequelize.query(
    `INSERT INTO "Subscription" ("id", "subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay",
                                 "currentPeriodStart", "currentPeriodEnd", "version")
     VALUES (:id, :subjectType, :subjectId, :priceId, :status, 1, 1, :periodStart, :periodEnd, :version)`,
    {
      replacements: {
        id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        priceId,
        status: input.status ?? 'ACTIVE',
        periodStart: input.periodStart ?? '2026-04-01T00:00:00.000Z',
        periodEnd: input.periodEnd ?? '2026-05-01T00:00:00.000Z',
        version: input.version ?? 0,
      },
    },
  );
  return { id, priceId };
}

/** A renewal invoice row, so the ledger's foreign key has something to point at (privileged setup). */
export async function seedInvoice(
  t: BillingTestApp,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
  measuredAt: string | null = null,
): Promise<string> {
  const id = uuidv4();
  await t.sequelize.query(
    `INSERT INTO "Invoice" ("id", "subscriptionId", "kind", "businessKey", "periodStart", "periodEnd", "status",
                            "total", "currency", "usageMeasuredAt", "paidAt")
     VALUES (:id, :subscriptionId, 'RENEWAL', :businessKey, :periodStart, :periodEnd, 'PAID', 0, 'EUR', :measuredAt,
             :periodStart)`,
    {
      replacements: {
        id,
        subscriptionId,
        businessKey: `renewal:${new Date(periodStart).toISOString()}:${id}`,
        periodStart,
        periodEnd,
        measuredAt,
      },
    },
  );
  return id;
}

/** Sets a seeded subscription's status and version, the way a committed S17 change would. */
export async function moveSubscription(
  t: BillingTestApp,
  subscriptionId: string,
  patch: { status?: string; version?: number },
): Promise<void> {
  await t.sequelize.query(
    `UPDATE "Subscription" SET "status" = COALESCE(:status, "status"), "version" = COALESCE(:version, "version"),
            "updatedAt" = now() WHERE "id" = :subscriptionId`,
    {
      replacements: {
        subscriptionId,
        status: patch.status ?? null,
        version: patch.version ?? null,
      },
    },
  );
}

/** The DS-1 entitlements of S18's spec (they differ from S17's seed in `seats` and the assistant allowance). */
export const S18_PLANS = {
  starter: {
    maxProducts: 100,
    seats: 3,
    auctions: false,
    apiCallsPerMonth: 10000,
    assistantTokensPerMonth: 0,
  },
  pro: {
    maxProducts: 10000,
    seats: 25,
    auctions: true,
    apiCallsPerMonth: 1000000,
    assistantTokensPerMonth: 5000000,
  },
  plus: {
    freeShipping: true,
    earlyAccessDrops: true,
    assistantTokensPerMonth: 2000000,
  },
} as const;

/** Puts S18's DS-1 entitlements on the three seeded plans (the catalog is reset to S17's DS-1 before every spec). */
export async function applyS18Plans(t: BillingTestApp): Promise<void> {
  for (const [code, entitlements] of Object.entries(S18_PLANS))
    await t.sequelize.query(
      `UPDATE "Plan" SET "entitlements" = CAST(:entitlements AS jsonb) WHERE "code" = :code`,
      { replacements: { code, entitlements: JSON.stringify(entitlements) } },
    );
}
