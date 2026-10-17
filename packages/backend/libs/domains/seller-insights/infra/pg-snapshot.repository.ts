import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type {
  ShopPosition,
  SnapshotPage,
  SnapshotRepository,
  SnapshotRow,
} from '../domain/ports';

interface Row {
  rank: number;
  shopId: string;
  shopName: string | null;
  revenue: string;
  participants: number;
}

/**
 * Frozen top-100 boards in PostgreSQL. A board is replaced in one transaction (`DELETE` + bulk `INSERT` with bound
 * parameters) under a per-period advisory lock, so concurrent runs are serial and a reader at READ COMMITTED sees the
 * old or the new set, never an empty or partial one (S40 FR-023).
 */
@Injectable()
export class PgSnapshotRepository implements SnapshotRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
  ) {}

  async isFrozen(periodId: string): Promise<boolean> {
    const rows = await this.sequelize.query(
      `SELECT 1 FROM "LeaderboardSnapshot" WHERE "period" = :periodId LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { periodId } },
    );
    return rows.length > 0;
  }

  replaceBoard(
    periodId: string,
    board: string,
    rows: SnapshotRow[],
    participants: number,
  ): Promise<void> {
    return this.tx.run(async () => {
      await this.sequelize.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, {
        bind: [`seller-insights:snapshot:${periodId}`],
      });
      await this.sequelize.query(
        `DELETE FROM "LeaderboardSnapshot" WHERE "period" = $1 AND "board" = $2`,
        { bind: [periodId, board] },
      );
      if (rows.length === 0) return;
      await this.sequelize.query(
        `INSERT INTO "LeaderboardSnapshot" ("period", "board", "rank", "shopId", "revenue", "shopName", "participants")
         SELECT $1, $2, r.rank, r.shop, r.revenue, r.name, $7
         FROM unnest($3::int[], $4::uuid[], $5::bigint[], $6::text[]) AS r(rank, shop, revenue, name)`,
        {
          bind: [
            periodId,
            board,
            rows.map((r) => r.rank),
            rows.map((r) => r.shopId),
            rows.map((r) => r.revenueMinor),
            rows.map((r) => r.shopName),
            participants,
          ],
        },
      );
    });
  }

  async top(
    periodId: string,
    board: string,
    limit: number,
  ): Promise<SnapshotPage> {
    const rows = await this.sequelize.query<Row>(
      `SELECT "rank", "shopId", "shopName", "revenue"::text AS "revenue", "participants"
       FROM "LeaderboardSnapshot" WHERE "period" = :periodId AND "board" = :board
       ORDER BY "rank" LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { periodId, board, limit } },
    );
    return {
      participants: rows[0]?.participants ?? 0,
      rows: rows.map((r) => ({
        rank: r.rank,
        shopId: r.shopId,
        shopName: r.shopName,
        revenueMinor: Number(r.revenue),
      })),
    };
  }

  async position(
    periodId: string,
    board: string,
    shopId: string,
  ): Promise<ShopPosition | null> {
    const [row] = await this.sequelize.query<Row>(
      `SELECT "rank", "revenue"::text AS "revenue", "participants"
       FROM "LeaderboardSnapshot"
       WHERE "period" = :periodId AND "board" = :board AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { periodId, board, shopId } },
    );
    return row
      ? {
          rank: row.rank,
          of: row.participants,
          revenueMinor: Number(row.revenue),
        }
      : null;
  }

  async frozenPeriodIds(kind: 'week' | 'month'): Promise<Set<string>> {
    const rows = await this.sequelize.query<{ period: string }>(
      `SELECT DISTINCT "period" FROM "LeaderboardSnapshot"
       WHERE "period" ${kind === 'week' ? 'LIKE' : 'NOT LIKE'} '%-W%'`,
      { type: QueryTypes.SELECT },
    );
    return new Set(rows.map((r) => r.period));
  }

  removeShop(shopId: string): Promise<void> {
    return this.tx.run(async () => {
      await this.sequelize.query(
        `WITH affected AS (
           SELECT DISTINCT "period", "board" FROM "LeaderboardSnapshot" WHERE "shopId" = :shopId
         ), moved AS (
           DELETE FROM "LeaderboardSnapshot" s USING affected a
           WHERE s."period" = a."period" AND s."board" = a."board" RETURNING s.*
         )
         INSERT INTO "LeaderboardSnapshot" ("period", "board", "rank", "shopId", "revenue", "shopName", "participants", "createdAt")
         SELECT "period", "board", row_number() OVER (PARTITION BY "period", "board" ORDER BY "rank"),
                "shopId", "revenue", "shopName", "participants" - 1, "createdAt"
         FROM moved WHERE "shopId" <> :shopId`,
        { replacements: { shopId } },
      );
    });
  }
}
