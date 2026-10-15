import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { CatalogRepository } from '../domain/ports';
import type {
  Audience,
  EntitlementValues,
  PlanRow,
  PriceRow,
  PriceWithPlan,
} from '../domain/types';
import type { BillingInterval } from '../domain/periods';
import { dateOrNull, minor, select } from './sql';

interface PlanDb {
  id: string;
  code: string;
  name: string;
  audience: Audience;
  entitlements: EntitlementValues;
  createdAt: Date;
}

interface PriceDb {
  id: string;
  planId: string;
  version: number;
  interval: BillingInterval;
  unitAmount: string;
  currency: string;
  perSeat: boolean;
  trialDays: number;
  includedUsage: Record<string, number>;
  overagePer1000: Record<string, number>;
  active: boolean;
  createdAt: Date;
}

const PLAN_COLUMNS = `p."id", p."code", p."name", p."audience", p."entitlements", p."createdAt"`;
const PRICE_COLUMNS = `pr."id", pr."planId", pr."version", pr."interval", pr."unitAmount", pr."currency", pr."perSeat",
  pr."trialDays", pr."includedUsage", pr."overagePer1000", pr."active", pr."createdAt"`;

const toPlan = (row: PlanDb): PlanRow => ({
  id: row.id,
  code: row.code,
  name: row.name,
  audience: row.audience,
  entitlements: row.entitlements,
  createdAt: new Date(row.createdAt),
});

export const toPrice = (row: PriceDb): PriceRow => ({
  id: row.id,
  planId: row.planId,
  version: row.version,
  interval: row.interval,
  unitAmountMinor: minor(row.unitAmount),
  currency: row.currency,
  perSeat: row.perSeat,
  trialDays: row.trialDays,
  includedUsage: row.includedUsage,
  overagePer1000Minor: row.overagePer1000,
  active: row.active,
  createdAt: dateOrNull(row.createdAt) ?? new Date(0),
});

export { PRICE_COLUMNS };

/** Plans and prices over raw SQL; the immutability of a price is the store's (`billing_price_immutable`), not ours. */
@Injectable()
export class SequelizeCatalogRepository implements CatalogRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async listActive() {
    const plans = await select<PlanDb>(
      this.sequelize,
      `SELECT ${PLAN_COLUMNS} FROM "Plan" p ORDER BY p."code", p."id"`,
    );
    const prices = await select<PriceDb>(
      this.sequelize,
      `SELECT ${PRICE_COLUMNS} FROM "Price" pr WHERE pr."active"
        ORDER BY pr."interval", pr."unitAmount", pr."id"`,
    );
    const byPlan = new Map<string, PriceRow[]>();
    for (const row of prices) {
      const list = byPlan.get(row.planId) ?? [];
      list.push(toPrice(row));
      byPlan.set(row.planId, list);
    }
    return plans
      .map((plan) => ({
        plan: toPlan(plan),
        prices: byPlan.get(plan.id) ?? [],
      }))
      .filter((entry) => entry.prices.length > 0);
  }

  async findPlan(planId: string) {
    const [row] = await select<PlanDb>(
      this.sequelize,
      `SELECT ${PLAN_COLUMNS} FROM "Plan" p WHERE p."id" = :planId`,
      { planId },
    );
    return row ? toPlan(row) : null;
  }

  async insertPlan(input: {
    code: string;
    name: string;
    audience: Audience;
    entitlements: EntitlementValues;
  }) {
    const [row] = await select<PlanDb>(
      this.sequelize,
      `INSERT INTO "Plan" ("code", "name", "audience", "entitlements")
       VALUES (:code, :name, :audience, CAST(:entitlements AS jsonb))
       ON CONFLICT ("code") DO NOTHING
       RETURNING "id", "code", "name", "audience", "entitlements", "createdAt"`,
      {
        code: input.code,
        name: input.name,
        audience: input.audience,
        entitlements: JSON.stringify(input.entitlements),
      },
    );
    return row ? toPlan(row) : null;
  }

  async insertPrice(
    planId: string,
    input: {
      interval: BillingInterval;
      unitAmountMinor: number;
      currency: string;
      perSeat: boolean;
      trialDays: number;
      includedUsage: Record<string, number>;
      overagePer1000Minor: Record<string, number>;
    },
  ) {
    // The next version of (plan, interval) is chosen in the same statement that inserts it; the unique index on
    // (planId, interval, version) turns a lost race into an error the caller retries once.
    const insert = () =>
      select<PriceDb>(
        this.sequelize,
        `INSERT INTO "Price" ("planId", "interval", "unitAmount", "currency", "perSeat", "trialDays",
                              "includedUsage", "overagePer1000", "version", "active")
         SELECT :planId, :interval, :unitAmount, :currency, :perSeat, :trialDays,
                CAST(:includedUsage AS jsonb), CAST(:overage AS jsonb),
                coalesce(max("version"), 0) + 1, TRUE
           FROM "Price" WHERE "planId" = :planId AND "interval" = :interval
         RETURNING "id", "planId", "version", "interval", "unitAmount", "currency", "perSeat", "trialDays",
                   "includedUsage", "overagePer1000", "active", "createdAt"`,
        {
          planId,
          interval: input.interval,
          unitAmount: input.unitAmountMinor,
          currency: input.currency,
          perSeat: input.perSeat,
          trialDays: input.trialDays,
          includedUsage: JSON.stringify(input.includedUsage),
          overage: JSON.stringify(input.overagePer1000Minor),
        },
      );
    let rows: PriceDb[];
    try {
      rows = await insert();
    } catch (error) {
      const code = (error as { parent?: { code?: string } }).parent?.code;
      if (code !== '23505') throw error;
      rows = await insert();
    }
    return toPrice(rows[0]);
  }

  async findPrice(priceId: string): Promise<PriceWithPlan | null> {
    const [row] = await select<
      PriceDb & { planCode: string; planName: string; audience: Audience }
    >(
      this.sequelize,
      `SELECT ${PRICE_COLUMNS}, p."code" AS "planCode", p."name" AS "planName", p."audience"
         FROM "Price" pr JOIN "Plan" p ON p."id" = pr."planId" WHERE pr."id" = :priceId`,
      { priceId },
    );
    return row
      ? {
          ...toPrice(row),
          plan: {
            code: row.planCode,
            name: row.planName,
            audience: row.audience,
          },
        }
      : null;
  }

  async retirePrice(priceId: string) {
    const [retired] = await select<{ id: string }>(
      this.sequelize,
      `UPDATE "Price" SET "active" = FALSE WHERE "id" = :priceId AND "active" RETURNING "id"`,
      { priceId },
    );
    if (retired) return 'retired' as const;
    const [exists] = await select<{ id: string }>(
      this.sequelize,
      `SELECT "id" FROM "Price" WHERE "id" = :priceId`,
      { priceId },
    );
    return exists ? ('already_retired' as const) : ('missing' as const);
  }
}
