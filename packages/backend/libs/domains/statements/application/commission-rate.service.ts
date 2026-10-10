import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';

export const DEFAULT_SHOP_KEY = '00000000-0000-0000-0000-000000000000';

import './commission-rate.job-types';

export interface RateRow {
  id: string;
  shopKey: string;
  category: string;
  rateBps: number;
  validFrom: string;
  validTo: string | null;
  recordedFrom: string;
  recordedTo: string | null;
  reason: string | null;
}

/**
 * Bitemporal commission rates (lesson 03/03 §7). Nothing is ever UPDATEd in
 * the business sense: setting a rate closes the recorded period of every
 * current row it overlaps and re-inserts their non-overlapping remainders,
 * then inserts the new row - so "what did we believe on April 1 about March?"
 * stays answerable forever.
 */
@Injectable()
export class CommissionRateService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly jobs: JobsService,
  ) {}

  async setRate(input: {
    shopId?: string;
    category: string;
    rateBps: number;
    validFrom: Date;
    validTo?: Date;
    reason: string;
  }): Promise<void> {
    const shopKey = input.shopId ?? DEFAULT_SHOP_KEY;
    const from = input.validFrom.toISOString();
    const to = input.validTo?.toISOString() ?? null;

    // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
    await this.sequelize.transaction(async (transaction) => {
      const q = async <T>(
        sql: string,
        replacements: Record<string, unknown>,
      ): Promise<T[]> =>
        (await this.sequelize.query(sql, {
          type: QueryTypes.SELECT,
          replacements,
          transaction,
        })) as T[];

      // Serialize writers per (shop, category); readers are never blocked (MVCC).
      await q(`SELECT pg_advisory_xact_lock(hashtext(:key))`, {
        key: `${shopKey}:${input.category}`,
      });

      // Range math stays in SQL (infinite bounds, inclusivity) - JS Dates can't represent ±infinity.
      const overlapping = await q<{
        id: string;
        rateBps: number;
        lo: string;
        hi: string | null;
        hasLeft: boolean;
        hasRight: boolean;
        reason: string | null;
      }>(
        `SELECT id, "rateBps", lower("validPeriod")::text AS lo, upper("validPeriod")::text AS hi, reason,
                lower_inf("validPeriod") OR lower("validPeriod") < CAST(:from AS timestamptz) AS "hasLeft",
                CAST(:to AS timestamptz) IS NOT NULL AND (upper_inf("validPeriod") OR upper("validPeriod") > CAST(:to AS timestamptz)) AS "hasRight"
         FROM "CommissionRate"
         WHERE "shopKey" = :shopKey AND category = :category AND upper_inf("recordedPeriod")
           AND "validPeriod" && tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz)) FOR UPDATE`,
        { shopKey, category: input.category, from, to },
      );

      for (const row of overlapping) {
        await this.exec(
          `UPDATE "CommissionRate" SET "recordedPeriod" = tstzrange(lower("recordedPeriod"), now()) WHERE id = :id`,
          { id: row.id },
          transaction,
        );
        // Keep what the new rate doesn't cover, as current knowledge.
        if (row.hasLeft)
          await this.insert(
            shopKey,
            input.category,
            row.rateBps,
            row.lo ?? '-infinity',
            from,
            row.reason,
            transaction,
          );
        if (row.hasRight)
          await this.insert(
            shopKey,
            input.category,
            row.rateBps,
            to!,
            row.hi,
            row.reason,
            transaction,
          );
      }
      await this.insert(
        shopKey,
        input.category,
        input.rateBps,
        from,
        to,
        input.reason,
        transaction,
      );

      // Retroactive change touching closed months → adjustments (closed statements never change).
      await this.jobs.enqueue('statements.retro-adjust', {
        shopKey,
        category: input.category,
        from,
        to,
        reason: input.reason,
      });
    });
  }

  async rateAsOf(
    shopId: string,
    category: string,
    validAt: Date,
    knownAt: Date = new Date(),
  ): Promise<number> {
    const [row] = await this.sequelize.query<{ rateBps: number }>(
      `SELECT "rateBps" FROM "CommissionRate"
       WHERE "shopKey" IN (:shopId, :default) AND category IN (:category, '*')
         AND "validPeriod" @> CAST(:validAt AS timestamptz) AND "recordedPeriod" @> CAST(:knownAt AS timestamptz)
       ORDER BY ("shopKey" = :default), (category = '*') LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          default: DEFAULT_SHOP_KEY,
          category,
          validAt: validAt.toISOString(),
          knownAt: knownAt.toISOString(),
        },
      },
    );
    return row?.rateBps ?? 0;
  }

  history(shopId: string | null, category: string): Promise<RateRow[]> {
    return this.sequelize.query<RateRow>(
      `SELECT id, "shopKey", category, "rateBps", lower("validPeriod") AS "validFrom", upper("validPeriod") AS "validTo",
              lower("recordedPeriod") AS "recordedFrom", upper("recordedPeriod") AS "recordedTo", reason
       FROM "CommissionRate" WHERE "shopKey" = :shopKey AND category = :category ORDER BY lower("recordedPeriod"), lower("validPeriod")`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopKey: shopId ?? DEFAULT_SHOP_KEY, category },
      },
    );
  }

  private insert(
    shopKey: string,
    category: string,
    rateBps: number,
    from: string,
    to: string | null,
    reason: string | null,
    transaction: Transaction,
  ) {
    return this.exec(
      `INSERT INTO "CommissionRate" ("shopKey", category, "rateBps", "validPeriod", reason)
       VALUES (:shopKey, :category, :rateBps, tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz)), :reason)`,
      { shopKey, category, rateBps, from, to, reason },
      transaction,
    );
  }

  private exec(
    sql: string,
    replacements: Record<string, unknown>,
    transaction: Transaction,
  ) {
    return this.sequelize.query(sql, { replacements, transaction });
  }
}
