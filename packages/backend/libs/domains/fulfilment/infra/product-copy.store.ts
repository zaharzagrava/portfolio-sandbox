import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { ProductCopyFacts } from '../domain/offer-document';
import type { ProductCopyStore } from '../domain/pickup-ports';

type CopyRow = ProductCopyFacts & { shopId: string };

/**
 * `PickupProductCopy`: the catalog fields the index shows, built from `catalog.product_*` events and seeded at stock
 * write (S19 FR-031). A copy is written only when its version is greater than the stored one, so a late or repeated
 * event changes nothing. The row is never written back to the catalog.
 */
@Injectable()
export class ProductCopySqlStore implements ProductCopyStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async upsert(copy: CopyRow): Promise<boolean> {
    const rows = await this.sequelize.query(
      `INSERT INTO "PickupProductCopy" AS c ("productId", "shopId", "title", "category", "priceMinor", "currency",
                                              "status", "isSandbox", "version", "updatedAt")
       VALUES (:productId, :shopId, :title, :category, :priceMinor, :currency, :status, :isSandbox, :version, now())
       ON CONFLICT ("productId") DO UPDATE
          SET "shopId" = EXCLUDED."shopId", "title" = EXCLUDED."title", "category" = EXCLUDED."category",
              "priceMinor" = EXCLUDED."priceMinor", "currency" = EXCLUDED."currency", "status" = EXCLUDED."status",
              "isSandbox" = EXCLUDED."isSandbox", "version" = EXCLUDED."version", "updatedAt" = now()
        WHERE c."version" < EXCLUDED."version"
       RETURNING c."productId"`,
      { type: QueryTypes.SELECT, replacements: { ...copy } },
    );
    return rows.length > 0;
  }

  async find(productId: string): Promise<CopyRow | null> {
    const [row] = await this.sequelize.query<
      Omit<CopyRow, 'priceMinor' | 'version'> & {
        priceMinor: string;
        version: string;
      }
    >(
      `SELECT "productId", "shopId", "title", "category", "priceMinor", "currency", "status", "isSandbox", "version"
         FROM "PickupProductCopy" WHERE "productId" = :productId`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    return row
      ? {
          ...row,
          priceMinor: Number(row.priceMinor),
          version: Number(row.version),
        }
      : null;
  }

  async remove(productId: string): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "PickupProductCopy" WHERE "productId" = :productId`,
      { replacements: { productId } },
    );
  }
}
