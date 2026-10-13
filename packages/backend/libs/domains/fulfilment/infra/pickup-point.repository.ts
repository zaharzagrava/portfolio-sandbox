import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  PickupPointChanges,
  PickupPointRecord,
  PickupPointRepository,
} from '../domain/pickup-ports';

const COLUMNS = `p."id", p."shopId", p."name", p."address", ST_Y(p."location"::geometry) AS "lat",
  ST_X(p."location"::geometry) AS "lng", p."openingHours", p."active", p."version", p."createdAt", p."updatedAt"`;

/**
 * `PickupPoint` behind its port: the shop is in every predicate (III.4), named replacements only, a fixed ORDER BY,
 * a transaction-scoped advisory lock for the per-shop cap (research R-5). Joins the caller's transaction through CLS.
 */
@Injectable()
export class PickupPointSqlRepository implements PickupPointRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object = PickupPointRecord>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async lockAndCount(shopId: string): Promise<number> {
    await this.select(
      `SELECT pg_advisory_xact_lock(hashtextextended('pickup-points:' || CAST(:shopId AS text), 0))`,
      { shopId },
    );
    const [row] = await this.select<{ n: number }>(
      `SELECT count(*)::int AS "n" FROM "PickupPoint" WHERE "shopId" = :shopId`,
      { shopId },
    );
    return row.n;
  }

  async insert(
    shopId: string,
    input: Parameters<PickupPointRepository['insert']>[1],
    now: Date,
  ): Promise<PickupPointRecord> {
    const [row] = await this.select(
      `INSERT INTO "PickupPoint" AS p ("shopId", "name", "address", "location", "openingHours", "createdAt", "updatedAt")
       VALUES (:shopId, :name, :address, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
               CAST(:hours AS JSONB), :now, :now)
       RETURNING ${COLUMNS}`,
      {
        shopId,
        name: input.name,
        address: input.address,
        lat: input.lat,
        lng: input.lng,
        hours: JSON.stringify(input.openingHours),
        now,
      },
    );
    return row;
  }

  async findInShop(
    shopId: string,
    pointId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<PickupPointRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "PickupPoint" p WHERE p."id" = :pointId AND p."shopId" = :shopId
       ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      { pointId, shopId },
    );
    return row ?? null;
  }

  async findById(pointId: string): Promise<PickupPointRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "PickupPoint" p WHERE p."id" = :pointId`,
      { pointId },
    );
    return row ?? null;
  }

  async update(
    shopId: string,
    pointId: string,
    changes: PickupPointChanges,
    now: Date,
  ): Promise<PickupPointRecord> {
    const [row] = await this.select(
      `UPDATE "PickupPoint" AS p
          SET "name" = COALESCE(CAST(:name AS text), p."name"),
              "address" = COALESCE(CAST(:address AS text), p."address"),
              "openingHours" = COALESCE(CAST(:hours AS JSONB), p."openingHours"),
              "active" = COALESCE(CAST(:active AS boolean), p."active"),
              "version" = p."version" + 1,
              "updatedAt" = :now
        WHERE p."id" = :pointId AND p."shopId" = :shopId
       RETURNING ${COLUMNS}`,
      {
        pointId,
        shopId,
        name: changes.name ?? null,
        address: changes.address ?? null,
        hours: changes.openingHours
          ? JSON.stringify(changes.openingHours)
          : null,
        active: changes.active ?? null,
        now,
      },
    );
    return row;
  }

  listPage(
    shopId: string,
    limit: number,
    after: [string, string] | null,
  ): Promise<PickupPointRecord[]> {
    return this.select(
      `SELECT ${COLUMNS} FROM "PickupPoint" p
        WHERE p."shopId" = :shopId
          AND (CAST(:afterAt AS timestamptz) IS NULL OR (p."createdAt", p."id") < (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY p."createdAt" DESC, p."id" DESC
        LIMIT :limit`,
      {
        shopId,
        limit,
        afterAt: after?.[0] ?? null,
        afterId: after?.[1] ?? null,
      },
    );
  }

  deactivateAllOfShop(shopId: string, now: Date): Promise<PickupPointRecord[]> {
    return this.select(
      `UPDATE "PickupPoint" AS p
          SET "active" = FALSE, "version" = p."version" + 1, "updatedAt" = :now
        WHERE p."shopId" = :shopId AND p."active"
       RETURNING ${COLUMNS}`,
      { shopId, now },
    );
  }
}
