import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { ShopDirectory, ShopName, VersionOutcome } from '../domain/ports';

/** The shop name read model (R3): a version-guarded upsert, so a stale rename or a replay never moves it back. */
@Injectable()
export class PgShopDirectory implements ShopDirectory {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
  ) {}

  async namesOf(shopIds: string[]): Promise<Map<string, ShopName>> {
    if (shopIds.length === 0) return new Map();
    const rows = await this.sequelize.query<{
      shopId: string;
      name: string;
      slug: string;
    }>(
      `SELECT "shopId", "name", "slug" FROM "SellerInsightsShop" WHERE "shopId" IN (:shopIds)`,
      { type: QueryTypes.SELECT, replacements: { shopIds } },
    );
    return new Map(rows.map((r) => [r.shopId, { name: r.name, slug: r.slug }]));
  }

  upsert(shop: {
    shopId: string;
    name: string;
    slug: string;
    shopVersion: number;
  }): Promise<VersionOutcome> {
    return this.tx.run(async () => {
      const [rows] = await this.sequelize.query(
        `INSERT INTO "SellerInsightsShop" ("shopId", "name", "slug", "shopVersion", "updatedAt")
         VALUES (:shopId, :name, :slug, :shopVersion, now())
         ON CONFLICT ("shopId") DO UPDATE
           SET "name" = EXCLUDED."name", "slug" = EXCLUDED."slug",
               "shopVersion" = EXCLUDED."shopVersion", "updatedAt" = now()
           WHERE EXCLUDED."shopVersion" > "SellerInsightsShop"."shopVersion"
         RETURNING "shopId"`,
        { replacements: shop },
      );
      return (rows as unknown[]).length > 0 ? 'applied' : 'stale';
    });
  }

  async remove(shopId: string): Promise<void> {
    await this.tx.run(async () => {
      await this.sequelize.query(
        `DELETE FROM "SellerInsightsShop" WHERE "shopId" = :shopId`,
        { replacements: { shopId } },
      );
    });
  }
}
