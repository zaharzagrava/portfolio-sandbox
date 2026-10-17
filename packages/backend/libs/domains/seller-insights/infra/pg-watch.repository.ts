import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import type {
  WatchCursor,
  WatchRecord,
  WatchRepository,
  WatchStatus,
  WatchView,
} from '../domain/crawler-ports';

interface WatchRow {
  id: string;
  shopId: string;
  productId: string;
  targetId: string;
  status: WatchStatus;
  createdAt: Date;
  lastEvaluatedObservationNo: number;
  lastEvaluatedPriceMinor: string | null;
}

interface ViewRow extends WatchRow {
  url: string;
  host: string;
  targetPriceMinor: string | null;
  targetCurrency: string | null;
  targetLastCheckedAt: Date | null;
  targetLastStatus: string | null;
  targetNextCheckAt: Date;
  targetObservationNo: number;
}

const num = (value: string | null): number | null =>
  value === null ? null : Number(value);

const toRecord = (row: WatchRow): WatchRecord => ({
  ...row,
  lastEvaluatedPriceMinor: num(row.lastEvaluatedPriceMinor),
});

const toView = (row: ViewRow): WatchView => ({
  ...toRecord(row),
  url: row.url,
  host: row.host,
  targetPriceMinor: num(row.targetPriceMinor),
  targetCurrency: row.targetCurrency,
  targetLastCheckedAt: row.targetLastCheckedAt,
  targetLastStatus: row.targetLastStatus,
  targetNextCheckAt: row.targetNextCheckAt,
  targetObservationNo: row.targetObservationNo,
});

const WATCH_COLUMNS = `w."id", w."shopId", w."productId", w."targetId", w."status", w."createdAt",
  w."lastEvaluatedObservationNo", w."lastEvaluatedPriceMinor"`;

const VIEW_SELECT = `SELECT ${WATCH_COLUMNS}, t."url", t."host", t."lastPriceMinor" AS "targetPriceMinor",
  t."currency" AS "targetCurrency", t."lastCheckedAt" AS "targetLastCheckedAt", t."lastStatus" AS "targetLastStatus",
  t."nextCheckAt" AS "targetNextCheckAt", t."observationNo" AS "targetObservationNo"
  FROM "CompetitorWatch" w JOIN "CrawlTarget" t ON t."id" = w."targetId"`;

/** `CompetitorWatch` rows. Every lookup of a watch carries the shop in its predicate (constitution III.4). */
@Injectable()
export class PgWatchRepository implements WatchRepository {
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

  async lockShop(shopId: string) {
    await this.sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('competitor-watch:' || :shopId, 0))`,
      { replacements: { shopId } },
    );
  }

  async countByShop(shopId: string) {
    const [row] = await this.select<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "CompetitorWatch" WHERE "shopId" = :shopId`,
      { shopId },
    );
    return row.n;
  }

  async countByProduct(shopId: string, productId: string) {
    const [row] = await this.select<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "CompetitorWatch" WHERE "shopId" = :shopId AND "productId" = :productId`,
      { shopId, productId },
    );
    return row.n;
  }

  async findByProductAndTarget(
    shopId: string,
    productId: string,
    targetId: string,
  ) {
    const [row] = await this.select<ViewRow>(
      `${VIEW_SELECT} WHERE w."shopId" = :shopId AND w."productId" = :productId AND w."targetId" = :targetId`,
      { shopId, productId, targetId },
    );
    return row ? toView(row) : null;
  }

  async insertIfAbsent(input: {
    shopId: string;
    productId: string;
    targetId: string;
    now: Date;
  }) {
    const rows = await this.select<WatchRow>(
      `INSERT INTO "CompetitorWatch" ("shopId", "productId", "targetId", "createdAt")
       VALUES (:shopId, :productId, :targetId, :now)
       ON CONFLICT ("productId", "targetId") DO NOTHING
       RETURNING "id", "shopId", "productId", "targetId", "status", "createdAt",
                 "lastEvaluatedObservationNo", "lastEvaluatedPriceMinor"`,
      input,
    );
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async findView(shopId: string, watchId: string) {
    const [row] = await this.select<ViewRow>(
      `${VIEW_SELECT} WHERE w."id" = :watchId AND w."shopId" = :shopId`,
      { shopId, watchId },
    );
    return row ? toView(row) : null;
  }

  async list(
    shopId: string,
    options: { productId?: string; limit: number; after?: WatchCursor },
  ) {
    const rows = await this.select<ViewRow>(
      `${VIEW_SELECT}
        WHERE w."shopId" = :shopId
          ${options.productId ? `AND w."productId" = :productId` : ''}
          ${options.after ? `AND (w."createdAt", w."id") < (:afterAt::timestamptz, :afterId::uuid)` : ''}
        ORDER BY w."createdAt" DESC, w."id" DESC
        LIMIT :limit`,
      {
        shopId,
        productId: options.productId,
        afterAt: options.after?.createdAt,
        afterId: options.after?.id,
        limit: options.limit,
      },
    );
    return rows.map(toView);
  }

  async deleteForShop(shopId: string, watchId: string) {
    const rows = await this.select<{ targetId: string }>(
      `DELETE FROM "CompetitorWatch" WHERE "id" = :watchId AND "shopId" = :shopId RETURNING "targetId"`,
      { shopId, watchId },
    );
    return rows.length === 0 ? null : rows[0].targetId;
  }

  async deleteByProduct(productId: string) {
    const rows = await this.select<{ targetId: string }>(
      `DELETE FROM "CompetitorWatch" WHERE "productId" = :productId RETURNING "targetId"`,
      { productId },
    );
    return [...new Set(rows.map((r) => r.targetId))];
  }

  async deleteByShop(shopId: string) {
    const rows = await this.select<{ targetId: string }>(
      `DELETE FROM "CompetitorWatch" WHERE "shopId" = :shopId RETURNING "targetId"`,
      { shopId },
    );
    return [...new Set(rows.map((r) => r.targetId))];
  }

  async setStatusForShop(shopId: string, status: WatchStatus) {
    const rows = await this.select<{ id: string }>(
      `UPDATE "CompetitorWatch" SET "status" = :status WHERE "shopId" = :shopId AND "status" <> :status RETURNING "id"`,
      { shopId, status },
    );
    return rows.length;
  }

  async pendingEvaluation(targetId: string, no: number, limit: number) {
    const rows = await this.select<WatchRow>(
      `SELECT ${WATCH_COLUMNS} FROM "CompetitorWatch" w
        WHERE w."targetId" = :targetId AND w."status" = 'ACTIVE' AND w."lastEvaluatedObservationNo" < :no
        ORDER BY w."id" LIMIT :limit`,
      { targetId, no, limit },
    );
    return rows.map(toRecord);
  }

  async claimEvaluation(watchIds: string[], no: number, priceMinor: number) {
    if (watchIds.length === 0) return [];
    const rows = await this.select<{ id: string }>(
      `UPDATE "CompetitorWatch"
          SET "lastEvaluatedObservationNo" = :no, "lastEvaluatedPriceMinor" = :priceMinor
        WHERE "id" IN (:watchIds) AND "status" = 'ACTIVE' AND "lastEvaluatedObservationNo" < :no
        RETURNING "id"`,
      { watchIds, no, priceMinor },
    );
    return rows.map((r) => r.id);
  }

  async countActiveForTarget(targetId: string) {
    const [row] = await this.select<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "CompetitorWatch" WHERE "targetId" = :targetId AND "status" = 'ACTIVE'`,
      { targetId },
    );
    return row.n;
  }
}
