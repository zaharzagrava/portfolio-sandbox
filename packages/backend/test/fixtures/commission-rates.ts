import type { Sequelize } from 'sequelize';

/** The platform default every shop and category falls back to: 1000 bps, valid and recorded for all time (as S16 seeds it). */
export const DEFAULT_COMMISSION_BPS = 1000;

/**
 * `CommissionRate` survives `seeds.clean()`. A spec of another domain that prices with `CommissionRateQueryService` (the
 * ledger settles with it) puts the table back to the single default belief here, so it never writes the table itself
 * (constitution IX.4).
 */
export async function resetCommissionRates(
  sequelize: Pick<Sequelize, 'query'>,
): Promise<void> {
  await sequelize.query(`DELETE FROM "CommissionRate"`);
  await sequelize.query(
    `INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason)
     VALUES ('00000000-0000-0000-0000-000000000000', '*', ${DEFAULT_COMMISSION_BPS}, tstzrange('-infinity', NULL), tstzrange('-infinity', NULL), 'initial default')`,
  );
}

/** A belief for one shop (and category), valid from `validFrom` and known at every instant of a fake clock. */
export async function setCommissionBelief(
  sequelize: Pick<Sequelize, 'query'>,
  rate: { shopId: string; category?: string; rateBps: number; validFrom: Date },
): Promise<void> {
  await sequelize.query(
    `INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason)
     VALUES (:shopId, :category, :rateBps, tstzrange(CAST(:validFrom AS timestamptz), NULL), tstzrange('-infinity', NULL), 'spec')`,
    {
      replacements: {
        shopId: rate.shopId,
        category: rate.category ?? '*',
        rateBps: rate.rateBps,
        validFrom: rate.validFrom.toISOString(),
      },
    },
  );
}
