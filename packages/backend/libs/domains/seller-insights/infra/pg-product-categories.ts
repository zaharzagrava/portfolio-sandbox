import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { ProductCategoryDirectory, VersionOutcome } from '../domain/ports';

/**
 * The product category read model (R3): a version-guarded upsert. A deleted product moves the version on and keeps the
 * last known category, so past sales stay attributable.
 */
@Injectable()
export class PgProductCategories implements ProductCategoryDirectory {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
  ) {}

  async categoriesOf(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.sequelize.query<{
      productId: string;
      category: string;
    }>(
      `SELECT "productId", "category" FROM "SellerInsightsProduct"
       WHERE "productId" IN (:productIds) AND "category" IS NOT NULL`,
      { type: QueryTypes.SELECT, replacements: { productIds } },
    );
    return new Map(rows.map((r) => [r.productId, r.category]));
  }

  upsert(product: {
    productId: string;
    shopId: string;
    category: string | null;
    productVersion: number;
  }): Promise<VersionOutcome> {
    return this.tx.run(async () => {
      const [rows] = await this.sequelize.query(
        `INSERT INTO "SellerInsightsProduct" ("productId", "shopId", "category", "productVersion", "updatedAt")
         VALUES (:productId, :shopId, :category, :productVersion, now())
         ON CONFLICT ("productId") DO UPDATE
           SET "shopId" = EXCLUDED."shopId",
               "category" = COALESCE(EXCLUDED."category", "SellerInsightsProduct"."category"),
               "productVersion" = EXCLUDED."productVersion", "updatedAt" = now()
           WHERE EXCLUDED."productVersion" > "SellerInsightsProduct"."productVersion"
         RETURNING "productId"`,
        { replacements: product },
      );
      return (rows as unknown[]).length > 0 ? 'applied' : 'stale';
    });
  }

  async removeByShop(shopId: string): Promise<void> {
    await this.tx.run(async () => {
      await this.sequelize.query(
        `DELETE FROM "SellerInsightsProduct" WHERE "shopId" = :shopId`,
        { replacements: { shopId } },
      );
    });
  }
}
