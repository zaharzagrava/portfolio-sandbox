import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  DigitalLinkRecord,
  DigitalLinkView,
  DigitalRepository,
} from '../domain/ports';
import { exec, num, one, rows } from './sql';

/** `DigitalProduct` (own table): at most one link per product. The product itself is the catalog's (R1). */
@Injectable()
export class SequelizeDigitalRepository implements DigitalRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  lockLink(productId: string): Promise<DigitalLinkRecord | null> {
    return one<DigitalLinkRecord>(
      this.db,
      `SELECT "productId", "shopId", "assetId", "linkedAt" FROM "DigitalProduct" WHERE "productId" = $productId FOR UPDATE`,
      { productId },
    );
  }

  async upsertLink(input: {
    productId: string;
    shopId: string;
    assetId: string;
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "DigitalProduct" ("productId", "shopId", "assetId", "linkedAt") VALUES ($productId, $shopId, $assetId, $now)
       ON CONFLICT ("productId") DO UPDATE SET "assetId" = EXCLUDED."assetId", "linkedAt" = EXCLUDED."linkedAt"`,
      input,
    );
  }

  async deleteLink(productId: string): Promise<void> {
    await exec(
      this.db,
      `DELETE FROM "DigitalProduct" WHERE "productId" = $productId`,
      {
        productId,
      },
    );
  }

  async view(
    shopId: string,
    productId: string,
  ): Promise<DigitalLinkView | null> {
    const r = await one<
      Omit<DigitalLinkView, 'sizeBytes'> & { sizeBytes: string | null }
    >(
      this.db,
      `SELECT d."productId", d."assetId", a."path", a."currentVersion" AS "version", v."sizeBytes", d."linkedAt"
         FROM "DigitalProduct" d
         JOIN "Asset" a ON a."id" = d."assetId"
         LEFT JOIN "AssetVersion" v ON v."assetId" = a."id" AND v."version" = a."currentVersion"
        WHERE d."productId" = $productId AND d."shopId" = $shopId`,
      { shopId, productId },
    );
    return r ? { ...r, sizeBytes: num(r.sizeBytes) } : null;
  }

  linksFor(productIds: string[]): Promise<DigitalLinkRecord[]> {
    if (productIds.length === 0) return Promise.resolve([]);
    return rows<DigitalLinkRecord>(
      this.db,
      `SELECT "productId", "shopId", "assetId", "linkedAt" FROM "DigitalProduct" WHERE "productId" = ANY($productIds::uuid[])`,
      { productIds },
    );
  }

  removeOfShop(shopId: string): Promise<DigitalLinkRecord[]> {
    return rows<DigitalLinkRecord>(
      this.db,
      `DELETE FROM "DigitalProduct" WHERE "shopId" = $shopId RETURNING "productId", "shopId", "assetId", "linkedAt"`,
      { shopId },
    );
  }
}
