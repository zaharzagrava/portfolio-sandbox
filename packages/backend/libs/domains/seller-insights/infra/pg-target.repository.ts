import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import type {
  DueTarget,
  TargetRecord,
  TargetRepository,
} from '../domain/crawler-ports';
import type { CrawlStatus } from '../domain/schedule';

interface TargetRow {
  id: string;
  url: string;
  host: string;
  lastPriceMinor: string | null;
  currency: string | null;
  simhash: string | null;
  unchangedStreak: number;
  noPriceStreak: number;
  errorStreak: number;
  lastStatus: string | null;
  lastCheckedAt: Date | null;
  nextCheckAt: Date;
  observationNo: number;
  evaluatedNo: number;
  retiredAt: Date | null;
}

const COLUMNS = `"id", "url", "host", "lastPriceMinor", "currency", "simhash", "unchangedStreak", "noPriceStreak",
  "errorStreak", "lastStatus", "lastCheckedAt", "nextCheckAt", "observationNo", "evaluatedNo", "retiredAt"`;

const toRecord = (row: TargetRow): TargetRecord => ({
  ...row,
  lastPriceMinor:
    row.lastPriceMinor === null ? null : Number(row.lastPriceMinor),
});

/** Plan weight of a watcher's shop: unknown shops count as the lowest plan (S41 FR-011). */
const PLAN_RANK = `CASE s."plan" WHEN 'ENTERPRISE' THEN 3 WHEN 'PRO' THEN 2 ELSE 1 END`;

/**
 * `CrawlTarget` rows. Every statement joins the caller's transaction (CLS) when there is one. Times come from the
 * caller's clock, never from `now()`, so a frozen test clock and the stored schedule agree.
 */
@Injectable()
export class PgTargetRepository implements TargetRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async upsertByUrl(url: string, host: string, now: Date) {
    await this.sequelize.query(
      `INSERT INTO "CrawlTarget" ("url", "host", "nextCheckAt") VALUES (:url, :host, :now) ON CONFLICT ("url") DO NOTHING`,
      { replacements: { url, host, now } },
    );
    const [row] = await this.select<TargetRow>(
      `SELECT ${COLUMNS} FROM "CrawlTarget" WHERE "url" = :url`,
      { url },
    );
    return toRecord(row);
  }

  async findById(id: string) {
    const [row] = await this.select<TargetRow>(
      `SELECT ${COLUMNS} FROM "CrawlTarget" WHERE "id" = :id`,
      { id },
    );
    return row ? toRecord(row) : null;
  }

  async findByUrl(url: string) {
    const [row] = await this.select<TargetRow>(
      `SELECT ${COLUMNS} FROM "CrawlTarget" WHERE "url" = :url`,
      { url },
    );
    return row ? toRecord(row) : null;
  }

  async pullForward(targetId: string, now: Date, minAgeMs: number) {
    const cutoff = new Date(now.getTime() - minAgeMs);
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET "nextCheckAt" = :now
         WHERE "id" = :targetId AND "retiredAt" IS NULL AND "nextCheckAt" > :now
           AND ("lastCheckedAt" IS NULL OR "lastCheckedAt" <= :cutoff)`,
      { replacements: { targetId, now, cutoff } },
    );
  }

  async revive(targetId: string) {
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET "retiredAt" = NULL WHERE "id" = :targetId AND "retiredAt" IS NOT NULL`,
      { replacements: { targetId } },
    );
  }

  due(now: Date, limit: number): Promise<DueTarget[]> {
    return this.select<DueTarget>(
      `SELECT t."id", t."host"
         FROM "CrawlTarget" t
        WHERE t."retiredAt" IS NULL AND t."nextCheckAt" <= :now
          AND EXISTS (SELECT 1 FROM "CompetitorWatch" w WHERE w."targetId" = t."id" AND w."status" = 'ACTIVE')
        ORDER BY (SELECT MAX(${PLAN_RANK}) FROM "CompetitorWatch" w
                    LEFT JOIN "CompetitorShop" s ON s."shopId" = w."shopId"
                   WHERE w."targetId" = t."id" AND w."status" = 'ACTIVE') DESC,
                 t."nextCheckAt" ASC, t."id" ASC
        LIMIT :limit`,
      { now, limit },
    );
  }

  async unevaluated(limit: number) {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "CrawlTarget" WHERE "evaluatedNo" < "observationNo" AND "retiredAt" IS NULL ORDER BY "id" LIMIT :limit`,
      { limit },
    );
    return rows.map((r) => r.id);
  }

  async overdue(now: Date) {
    const [row] = await this.select<{ count: string; oldest: Date | null }>(
      `SELECT COUNT(*)::text AS "count", MIN(t."nextCheckAt") AS "oldest"
         FROM "CrawlTarget" t
        WHERE t."retiredAt" IS NULL AND t."nextCheckAt" <= :now
          AND EXISTS (SELECT 1 FROM "CompetitorWatch" w WHERE w."targetId" = t."id" AND w."status" = 'ACTIVE')`,
      { now },
    );
    return {
      count: Number(row.count),
      oldestSeconds: row.oldest
        ? Math.max(0, Math.floor((now.getTime() - row.oldest.getTime()) / 1000))
        : 0,
    };
  }

  async recordOutcome(input: {
    id: string;
    status: CrawlStatus;
    now: Date;
    nextCheckAt: Date;
    unchangedStreak?: number;
    noPriceStreak?: number;
    errorStreak?: number;
    simhash?: string | null;
  }) {
    const sets = [
      `"lastStatus" = :status`,
      `"lastCheckedAt" = :now`,
      `"nextCheckAt" = :nextCheckAt`,
    ];
    if (input.unchangedStreak !== undefined)
      sets.push(`"unchangedStreak" = :unchangedStreak`);
    if (input.noPriceStreak !== undefined)
      sets.push(`"noPriceStreak" = :noPriceStreak`);
    if (input.errorStreak !== undefined)
      sets.push(`"errorStreak" = :errorStreak`);
    if (input.simhash !== undefined) sets.push(`"simhash" = :simhash`);
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET ${sets.join(', ')} WHERE "id" = :id`,
      { replacements: { simhash: null, ...input } },
    );
  }

  async recordObservation(input: {
    id: string;
    expectedNo: number;
    priceMinor: number;
    currency: string;
    simhash: string;
    now: Date;
    nextCheckAt: Date;
  }) {
    const rows = await this.select<{ observationNo: number }>(
      `UPDATE "CrawlTarget"
          SET "lastPriceMinor" = :priceMinor, "currency" = :currency, "simhash" = :simhash,
              "unchangedStreak" = 0, "noPriceStreak" = 0, "errorStreak" = 0,
              "observationNo" = "observationNo" + 1, "lastObservedAt" = :now, "lastStatus" = 'ok',
              "lastCheckedAt" = :now, "nextCheckAt" = :nextCheckAt
        WHERE "id" = :id AND "observationNo" = :expectedNo
        RETURNING "observationNo"`,
      input,
    );
    return rows.length === 0 ? null : rows[0].observationNo;
  }

  async setEvaluated(id: string, no: number) {
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET "evaluatedNo" = :no WHERE "id" = :id AND "evaluatedNo" < :no`,
      { replacements: { id, no } },
    );
  }

  async retireUnwatched(targetIds: string[], now: Date) {
    if (targetIds.length === 0) return 0;
    const rows = await this.select<{ id: string }>(
      `UPDATE "CrawlTarget" t SET "retiredAt" = :now
        WHERE t."id" IN (:targetIds) AND t."retiredAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "CompetitorWatch" w WHERE w."targetId" = t."id")
        RETURNING t."id"`,
      { targetIds: [...new Set(targetIds)], now },
    );
    return rows.length;
  }

  async purgeRetired(before: Date, batch: number) {
    const rows = await this.select<{ id: string }>(
      `WITH doomed AS (
         SELECT t."id" FROM "CrawlTarget" t
          WHERE t."retiredAt" IS NOT NULL AND t."retiredAt" < :before
            AND NOT EXISTS (SELECT 1 FROM "CompetitorWatch" w WHERE w."targetId" = t."id")
          ORDER BY t."retiredAt" LIMIT :batch FOR UPDATE SKIP LOCKED)
       DELETE FROM "CrawlTarget" t USING doomed WHERE t."id" = doomed."id" RETURNING t."id"`,
      { before, batch },
    );
    return rows.length;
  }
}
