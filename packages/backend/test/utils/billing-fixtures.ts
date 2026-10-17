import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { EntitlementsService } from '@app/domains/billing';

/**
 * Shared seeding of a shop's competitor-watch entitlement for specs of other capabilities (S41). Test code may touch
 * every table (IX.6); the helpers live here so a capability's own testing kit never writes billing tables.
 *
 * Two seeded plans carry the limit while a spec runs: `pro` allows 5 watches, `starter` 100. A shop without a
 * subscription is on the free tier, which allows 0.
 */
const LIMIT_PLANS: Record<number, string> = { 5: 'pro', 100: 'starter' };

const sequelizeOf = (app: INestApplication) =>
  app.get<Sequelize>(getConnectionToken(), { strict: false });

/** Puts `maxCompetitorWatches` on the `pro` (5) and `starter` (100) plans; call `removeCompetitorWatchLimits` at the end. */
export async function installCompetitorWatchLimits(
  app: INestApplication,
): Promise<void> {
  const sequelize = sequelizeOf(app);
  for (const [limit, code] of Object.entries(LIMIT_PLANS))
    await sequelize.query(
      `UPDATE "Plan" SET "entitlements" = "entitlements" || CAST(:entitlements AS jsonb) WHERE "code" = :code`,
      {
        replacements: {
          code,
          entitlements: JSON.stringify({ maxCompetitorWatches: Number(limit) }),
        },
      },
    );
}

export async function removeCompetitorWatchLimits(
  app: INestApplication,
): Promise<void> {
  const sequelize = sequelizeOf(app);
  await clearShopSubscriptions(app);
  await sequelize.query(
    `UPDATE "Plan" SET "entitlements" = "entitlements" - 'maxCompetitorWatches' WHERE "code" IN ('pro', 'starter')`,
  );
}

/** Drops the shop subscriptions the helpers wrote. */
export async function clearShopSubscriptions(
  app: INestApplication,
): Promise<void> {
  await sequelizeOf(app).query(
    `DELETE FROM "Subscription" WHERE "subjectType" = 'SHOP' AND "priceId" IN (
       SELECT pr."id" FROM "Price" pr JOIN "Plan" p ON p."id" = pr."planId" WHERE p."code" IN ('pro', 'starter'))`,
  );
}

/** The shop's `maxCompetitorWatches` from now on: 0 is the free tier, 5 and 100 are the two seeded plans. */
export async function setShopWatchLimit(
  app: INestApplication,
  shopId: string,
  limit: number,
): Promise<void> {
  const sequelize = sequelizeOf(app);
  await sequelize.query(
    `DELETE FROM "Subscription" WHERE "subjectId" = :shopId`,
    {
      replacements: { shopId },
    },
  );
  if (limit > 0) {
    const code = LIMIT_PLANS[limit];
    if (!code)
      throw new Error(`no billing plan carries a limit of ${limit} watches`);
    const [price] = await sequelize.query<{ id: string }>(
      `SELECT pr."id" FROM "Price" pr JOIN "Plan" p ON p."id" = pr."planId"
        WHERE p."code" = :code AND pr."interval" = 'MONTH' AND pr."active" ORDER BY pr."version" ASC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { code } },
    );
    await sequelize.query(
      `INSERT INTO "Subscription" ("id", "subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay",
                                   "currentPeriodStart", "currentPeriodEnd", "version")
       VALUES (:id, 'SHOP', :shopId, :priceId, 'ACTIVE', 1, 1, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 0)`,
      { replacements: { id: uuidv4(), shopId, priceId: price.id } },
    );
  }
  await app.get(EntitlementsService).invalidate('SHOP', shopId);
}
