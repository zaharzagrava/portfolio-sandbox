import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  PickupShortage,
  PickupStockRecord,
  PickupStockRepository,
} from '../domain/pickup-ports';

const COLUMNS = `s."pickupPointId", s."productId", s."quantity", s."version", s."updatedAt"`;

/**
 * `PickupStock` behind its port. A row is locked with `FOR UPDATE` and changed through the rules of `stock-rules.ts`;
 * the table's own CHECKs (`quantity >= 0`, `quantity <= 1000000`) are the store-level guarantee behind them. Joins the
 * caller's transaction through CLS.
 */
@Injectable()
export class PickupStockSqlRepository implements PickupStockRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object = PickupStockRecord>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async lockRow(pickupPointId: string, productId: string) {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "PickupStock" s
        WHERE s."pickupPointId" = :pickupPointId AND s."productId" = :productId FOR UPDATE`,
      { pickupPointId, productId },
    );
    return row ?? null;
  }

  async insert(
    pickupPointId: string,
    productId: string,
    quantity: number,
    now: Date,
  ) {
    const [row] = await this.select(
      `INSERT INTO "PickupStock" AS s ("pickupPointId", "productId", "quantity", "version", "updatedAt")
       VALUES (:pickupPointId, :productId, :quantity, 1, :now)
       ON CONFLICT ("pickupPointId", "productId") DO NOTHING
       RETURNING ${COLUMNS}`,
      { pickupPointId, productId, quantity, now },
    );
    return row ?? null;
  }

  async update(
    pickupPointId: string,
    productId: string,
    quantity: number,
    version: number,
    now: Date,
  ) {
    const [row] = await this.select(
      `UPDATE "PickupStock" AS s SET "quantity" = :quantity, "version" = :version, "updatedAt" = :now
        WHERE s."pickupPointId" = :pickupPointId AND s."productId" = :productId
       RETURNING ${COLUMNS}`,
      { pickupPointId, productId, quantity, version, now },
    );
    return row;
  }

  async find(pickupPointId: string, productId: string) {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "PickupStock" s
        WHERE s."pickupPointId" = :pickupPointId AND s."productId" = :productId`,
      { pickupPointId, productId },
    );
    return row ?? null;
  }

  listOfPoint(
    pickupPointId: string,
    limit: number,
    afterProductId: string | null,
  ) {
    return this.select(
      `SELECT ${COLUMNS} FROM "PickupStock" s
        WHERE s."pickupPointId" = :pickupPointId
          AND (CAST(:after AS uuid) IS NULL OR s."productId" > CAST(:after AS uuid))
        ORDER BY s."productId" ASC LIMIT :limit`,
      { pickupPointId, limit, after: afterProductId },
    );
  }

  listOfProduct(productId: string) {
    return this.select(
      `SELECT ${COLUMNS} FROM "PickupStock" s WHERE s."productId" = :productId ORDER BY s."pickupPointId" ASC`,
      { productId },
    );
  }

  listOfShop(shopId: string, limit: number, after: [string, string] | null) {
    return this.select(
      `SELECT ${COLUMNS} FROM "PickupStock" s
         JOIN "PickupPoint" p ON p."id" = s."pickupPointId"
        WHERE p."shopId" = :shopId
          AND (CAST(:afterPoint AS uuid) IS NULL
               OR (s."pickupPointId", s."productId") > (CAST(:afterPoint AS uuid), CAST(:afterProduct AS uuid)))
        ORDER BY s."pickupPointId" ASC, s."productId" ASC LIMIT :limit`,
      {
        shopId,
        limit,
        afterPoint: after?.[0] ?? null,
        afterProduct: after?.[1] ?? null,
      },
    );
  }

  deleteOfProduct(productId: string) {
    return this.select(
      `DELETE FROM "PickupStock" AS s WHERE s."productId" = :productId RETURNING ${COLUMNS}`,
      { productId },
    );
  }

  /**
   * One statement for the whole batch: the point's `active` flag and, for every requested line the point cannot serve,
   * what it holds (0 when there is no row), in the order of the request.
   */
  async checkLines(
    pickupPointId: string,
    lines: { productId: string; quantity: number }[],
  ): Promise<{ active: boolean; shortages: PickupShortage[] } | null> {
    const [row] = await this.select<{
      active: boolean;
      shortages: PickupShortage[];
    }>(
      `SELECT p."active",
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('productId', l."productId", 'requested', l."requested",
                                                    'available', COALESCE(s."quantity", 0)) ORDER BY l."ordinal")
                  FROM jsonb_to_recordset(CAST(:lines AS jsonb)) AS l("productId" uuid, "requested" int, "ordinal" int)
                  LEFT JOIN "PickupStock" s ON s."pickupPointId" = p."id" AND s."productId" = l."productId"
                 WHERE COALESCE(s."quantity", 0) < l."requested"
              ), '[]'::jsonb) AS "shortages"
         FROM "PickupPoint" p
        WHERE p."id" = :pickupPointId`,
      {
        pickupPointId,
        lines: JSON.stringify(
          lines.map((l, ordinal) => ({
            productId: l.productId,
            requested: l.quantity,
            ordinal,
          })),
        ),
      },
    );
    return row ?? null;
  }
}
