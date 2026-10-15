import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { CommissionRateRule } from '@marketplace-sandbox/contracts';
import {
  DEFAULT_SHOP_KEY,
  type HistoryAfter,
  type HistoryFilter,
  type NewBelief,
  type OverlappingBelief,
  type RateAsOfQuery,
  type RateAsOfRow,
  type RateBeliefRow,
  type RateRepository,
} from '../domain/ports';
import { iso, trimMicros } from './sql';

const RULE_SQL = `CASE WHEN "shopKey" = :default
    THEN (CASE WHEN category = '*' THEN 'default_any' ELSE 'default_category' END)
    ELSE (CASE WHEN category = '*' THEN 'shop_any' ELSE 'shop_category' END) END`;

/**
 * Bitemporal `CommissionRate` over raw SQL (range math stays in the database: JS dates cannot hold infinity). Every
 * call joins the caller's transaction through CLS. Values are bound parameters only.
 */
@Injectable()
export class SequelizeCommissionRateRepository implements RateRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
  ) {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async lockWriters(shopKey: string, category: string): Promise<void> {
    await this.select(
      `SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))`,
      { key: `statements:rate:${shopKey}:${category}` },
    );
  }

  async findOverlapping(
    shopKey: string,
    category: string,
    validFrom: string,
    validTo: string | null,
    rateBps: number,
  ): Promise<OverlappingBelief[]> {
    return this.select<OverlappingBelief>(
      `SELECT id, "changeId", "rateBps", reason, "recordedBy",
              coalesce(lower("validPeriod")::text, '-infinity') AS "validLower",
              ${iso('lower("recordedPeriod")')} AS "recordedFrom",
              upper("validPeriod")::text AS "validUpper",
              ("validPeriod" @> tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz))
                AND "rateBps" = :rateBps) AS "coversRange",
              (lower_inf("validPeriod") OR lower("validPeriod") < CAST(:from AS timestamptz)) AS "hasLeft",
              (CAST(:to AS timestamptz) IS NOT NULL
                AND (upper_inf("validPeriod") OR upper("validPeriod") > CAST(:to AS timestamptz))) AS "hasRight"
         FROM "CommissionRate"
        WHERE "shopKey" = :shopKey AND category = :category AND upper_inf("recordedPeriod")
          AND "validPeriod" && tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz))
        ORDER BY lower("validPeriod") NULLS FIRST
          FOR UPDATE`,
      { shopKey, category, from: validFrom, to: validTo, rateBps },
    );
  }

  async reasonOfChange(changeId: string): Promise<string | null> {
    const [row] = await this.select<{ reason: string | null }>(
      `SELECT reason FROM "CommissionRate" WHERE "changeId" = CAST(:changeId AS uuid) ORDER BY id LIMIT 1`,
      { changeId },
    );
    return row?.reason ?? null;
  }

  async lastRecordedMicros(
    shopKey: string,
    category: string,
  ): Promise<bigint | null> {
    const [row] = await this.select<{ micros: string | null }>(
      `SELECT (extract(epoch FROM max(lower("recordedPeriod")) FILTER (WHERE isfinite(lower("recordedPeriod")))) * 1000000)::bigint::text AS micros
         FROM "CommissionRate" WHERE "shopKey" = :shopKey AND category = :category`,
      { shopKey, category },
    );
    return row?.micros ? BigInt(row.micros) : null;
  }

  async closeRecordedPeriod(id: string, atIso: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "CommissionRate" SET "recordedPeriod" = tstzrange(lower("recordedPeriod"), CAST(:at AS timestamptz))
        WHERE id = :id`,
      { replacements: { id, at: atIso } },
    );
  }

  async insertBelief(belief: NewBelief): Promise<string> {
    const [row] = await this.select<{ id: string }>(
      `INSERT INTO "CommissionRate"
         ("shopKey", category, "rateBps", "validPeriod", "recordedPeriod", reason, "changeId", "recordedBy")
       VALUES (:shopKey, :category, :rateBps,
               tstzrange(CAST(:from AS timestamptz), CAST(:to AS timestamptz)),
               tstzrange(CAST(:recorded AS timestamptz), NULL),
               :reason, :changeId, :recordedBy)
       RETURNING id`,
      {
        shopKey: belief.shopKey,
        category: belief.category,
        rateBps: belief.rateBps,
        from: belief.validFrom,
        to: belief.validTo,
        recorded: belief.recordedFromIso,
        reason: belief.reason,
        changeId: belief.changeId,
        recordedBy: belief.recordedBy,
      },
    );
    return row.id;
  }

  async defaultCoversAllTime(): Promise<boolean> {
    const [row] = await this.select<{ covers: boolean }>(
      `SELECT coalesce(count(*) = 1
                AND bool_and(coalesce(lower(r), '-infinity') = '-infinity')
                AND bool_and(upper_inf(r)), false) AS covers
         FROM (SELECT unnest(range_agg("validPeriod")) AS r
                 FROM "CommissionRate"
                WHERE "shopKey" = :default AND category = '*' AND upper_inf("recordedPeriod")) s`,
      { default: DEFAULT_SHOP_KEY },
    );
    return row?.covers === true;
  }

  async history(
    filter: HistoryFilter,
    after: HistoryAfter | null,
    limit: number,
  ): Promise<RateBeliefRow[]> {
    const rows = await this.select<RateBeliefRow & { shopKey: string }>(
      `SELECT id, "changeId", "shopKey", category, "rateBps", reason, "recordedBy",
              ${iso('lower("validPeriod")')} AS "validFrom",
              ${iso('upper("validPeriod")')} AS "validTo",
              ${iso('lower("recordedPeriod")')} AS "recordedFrom",
              ${iso('upper("recordedPeriod")')} AS "recordedTo"
         FROM "CommissionRate"
        WHERE (CAST(:shopKey AS uuid) IS NULL OR "shopKey" = CAST(:shopKey AS uuid))
          AND (CAST(:category AS text) IS NULL OR category = CAST(:category AS text))
          AND (CAST(:afterRecorded AS timestamptz) IS NULL
               OR (lower("recordedPeriod"), id) < (CAST(:afterRecorded AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY lower("recordedPeriod") DESC, id DESC
        LIMIT :limit`,
      {
        shopKey: filter.shopKey ?? null,
        category: filter.category ?? null,
        afterRecorded: after?.recordedFrom ?? null,
        afterId: after?.id ?? null,
        limit,
      },
    );
    return rows.map((row) => ({
      id: row.id,
      changeId: row.changeId,
      shopId: row.shopKey === DEFAULT_SHOP_KEY ? null : row.shopKey,
      category: row.category,
      rateBps: row.rateBps,
      validFrom: trimMicros(row.validFrom),
      validTo: trimMicros(row.validTo),
      recordedFrom: trimMicros(row.recordedFrom),
      recordedTo: trimMicros(row.recordedTo),
      reason: row.reason,
      recordedBy: row.recordedBy,
    }));
  }

  async asOf(
    shopId: string | null,
    category: string,
    validAt: Date,
    knownAt: Date,
  ): Promise<RateAsOfRow | null> {
    const [row] = await this.select<RateAsOfRow>(
      `SELECT "rateBps", ${RULE_SQL} AS rule,
              ${iso('lower("validPeriod")')} AS "validFrom",
              ${iso('upper("validPeriod")')} AS "validTo",
              ${iso('lower("recordedPeriod")')} AS "recordedFrom"
         FROM "CommissionRate"
        WHERE "shopKey" IN (:shopKey, :default) AND category IN (:category, '*')
          AND "validPeriod" @> CAST(:validAt AS timestamptz)
          AND "recordedPeriod" @> CAST(:knownAt AS timestamptz)
        ORDER BY ("shopKey" = :default), (category = '*')
        LIMIT 1`,
      {
        shopKey: shopId ?? DEFAULT_SHOP_KEY,
        default: DEFAULT_SHOP_KEY,
        category,
        validAt: validAt.toISOString(),
        knownAt: knownAt.toISOString(),
      },
    );
    return row
      ? {
          ...row,
          validFrom: trimMicros(row.validFrom),
          validTo: trimMicros(row.validTo),
          recordedFrom: trimMicros(row.recordedFrom),
        }
      : null;
  }

  async asOfBatch(
    queries: RateAsOfQuery[],
    knownAt: Date,
  ): Promise<{ rateBps: number; rule: CommissionRateRule }[]> {
    if (queries.length === 0) return [];
    const rows = await this.sequelize.query<{
      ord: string;
      rateBps: number | null;
      rule: CommissionRateRule | null;
    }>(
      `SELECT q.ord, r."rateBps", r.rule
         FROM unnest($1::uuid[], $2::text[], $3::timestamptz[]) WITH ORDINALITY AS q(shop, category, valid_at, ord)
         LEFT JOIN LATERAL (
           SELECT "rateBps", ${RULE_SQL.replace(/:default/g, '$5::uuid')} AS rule
             FROM "CommissionRate"
            WHERE "shopKey" IN (q.shop, $5::uuid) AND category IN (q.category, '*')
              AND "validPeriod" @> q.valid_at AND "recordedPeriod" @> $4::timestamptz
            ORDER BY ("shopKey" = $5::uuid), (category = '*')
            LIMIT 1) r ON true
        ORDER BY q.ord`,
      {
        type: QueryTypes.SELECT,
        bind: [
          queries.map((q) => q.shopId),
          queries.map((q) => q.category),
          queries.map((q) => q.validAt.toISOString()),
          knownAt.toISOString(),
          DEFAULT_SHOP_KEY,
        ],
      },
    );
    return rows.map((row) => {
      if (row.rateBps === null || row.rule === null)
        throw new Error('no commission rate resolves: the default has a hole');
      return { rateBps: row.rateBps, rule: row.rule };
    });
  }
}
