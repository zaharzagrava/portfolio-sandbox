import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  LegacyBackfillRepository,
  ShopStateRepository,
  ShopSweepRepository,
} from '../domain/ports';
import type { ShopStateStatus } from '../domain/visibility';
import type { ProductRecord } from '../domain/product-view';
import { PRODUCT_COLUMNS, toProductRecord } from './product.repository';

/** Postgres adapter of the catalog's copy of the shop status (`ProductShopState`). */
@Injectable()
export class SequelizeShopStateRepository implements ShopStateRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(shopId: string) {
    const [row] = await this.sequelize.query<{
      status: ShopStateStatus;
      shopVersion: number;
    }>(
      `SELECT "status","shopVersion" FROM "ProductShopState" WHERE "shopId" = $1`,
      {
        bind: [shopId],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return row ?? null;
  }

  async apply(
    shopId: string,
    status: ShopStateStatus,
    shopVersion: number,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.sequelize.query(
      `INSERT INTO "ProductShopState" ("shopId","status","shopVersion","updatedAt") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("shopId") DO UPDATE
         SET "status" = EXCLUDED."status", "shopVersion" = EXCLUDED."shopVersion", "updatedAt" = EXCLUDED."updatedAt"
         WHERE "ProductShopState"."shopVersion" < EXCLUDED."shopVersion"
       RETURNING "shopId"`,
      {
        bind: [shopId, status, shopVersion, now],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.length > 0;
  }

  async remove(shopId: string): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "ProductShopState" WHERE "shopId" = $1`,
      { bind: [shopId], transaction: getActiveTransaction() },
    );
  }
}

@Injectable()
export class SequelizeShopSweepRepository implements ShopSweepRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async idsAfter(
    shopId: string,
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.sequelize.query<{ id: string }>(
      `SELECT "id" FROM "Product" WHERE "shopId" = $1 AND ($2::uuid IS NULL OR "id" > $2::uuid)
       ORDER BY "id" LIMIT $3`,
      {
        bind: [shopId, after, limit],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.map((r) => r.id);
  }

  lockBatch(shopId: string, limit: number) {
    return this.sequelize.query<{ id: string; version: number }>(
      `SELECT "id","version" FROM "Product" WHERE "shopId" = $1 ORDER BY "id" LIMIT $2 FOR UPDATE SKIP LOCKED`,
      {
        bind: [shopId, limit],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
  }

  async deleteBatch(shopId: string, ids: string[]): Promise<void> {
    const transaction = getActiveTransaction();
    const bind = [shopId, ids];
    for (const table of ['ProductStatusHistory', 'ProductStockOperation'])
      await this.sequelize.query(
        `DELETE FROM "${table}" WHERE "shopId" = $1 AND "productId" = ANY($2::uuid[])`,
        { bind, transaction },
      );
    await this.sequelize.query(
      `DELETE FROM "Product" WHERE "shopId" = $1 AND "id" = ANY($2::uuid[])`,
      { bind, transaction },
    );
  }
}

@Injectable()
export class SequelizeLegacyBackfillRepository implements LegacyBackfillRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async legacySellers(limit: number): Promise<string[]> {
    const rows = await this.sequelize.query<{ owner: string }>(
      `SELECT DISTINCT COALESCE("sellerId","createdBy") AS owner FROM "Product"
       WHERE "shopId" IS NULL AND COALESCE("sellerId","createdBy") IS NOT NULL
       ORDER BY owner LIMIT $1`,
      {
        bind: [limit],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.map((r) => r.owner);
  }

  async orphanCount(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Product" WHERE "shopId" IS NULL AND COALESCE("sellerId","createdBy") IS NULL`,
      { transaction: getActiveTransaction(), type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  async assignShop(
    sellerId: string,
    shopId: string,
    limit: number,
    now: Date,
  ): Promise<ProductRecord[]> {
    const rows = await this.sequelize.query<
      Parameters<typeof toProductRecord>[0]
    >(
      `WITH picked AS (
         SELECT "id" FROM "Product"
         WHERE "shopId" IS NULL AND COALESCE("sellerId","createdBy") = $1::uuid
         ORDER BY "id" LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE "Product" AS p SET "shopId" = $3, "version" = p."version" + 1, "updatedAt" = $4
       FROM picked WHERE p."id" = picked."id"
       RETURNING ${PRODUCT_COLUMNS}`,
      {
        bind: [sellerId, limit, shopId, now],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.map(toProductRecord);
  }
}
