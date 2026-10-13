import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  ProductSnapshot,
  ProductSnapshotStore,
  ShopSnapshot,
  ShopSnapshotStore,
} from '../domain/ads-ports';

/**
 * `AdProductSnapshot` (R3 read model of the catalog): written by a version-guarded upsert, so a duplicate or older event
 * changes nothing (IX.8, AS-70). A delete writes `status = 'DELETED'`. Joins the caller's transaction through CLS, so the
 * snapshot, the campaign effect and the outbox rows commit together.
 */
@Injectable()
export class SequelizeProductSnapshotStore implements ProductSnapshotStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async upsertIfNewer(snapshot: ProductSnapshot, now: Date): Promise<boolean> {
    const rows = await this.sequelize.query(
      `INSERT INTO "AdProductSnapshot" AS s ("productId", "shopId", "title", "category", "priceMinor", "currency",
                                              "inStock", "status", "isSandbox", "productVersion", "updatedAt")
       VALUES (:productId, :shopId, :title, :category, :priceMinor, :currency, :inStock, :status, :isSandbox,
               :productVersion, :now)
       ON CONFLICT ("productId") DO UPDATE
          SET "shopId" = EXCLUDED."shopId", "title" = EXCLUDED."title", "category" = EXCLUDED."category",
              "priceMinor" = EXCLUDED."priceMinor", "currency" = EXCLUDED."currency", "inStock" = EXCLUDED."inStock",
              "status" = EXCLUDED."status", "isSandbox" = EXCLUDED."isSandbox",
              "productVersion" = EXCLUDED."productVersion", "updatedAt" = EXCLUDED."updatedAt"
        WHERE s."productVersion" < EXCLUDED."productVersion"
       RETURNING s."productId"`,
      { type: QueryTypes.SELECT, replacements: { ...snapshot, now } },
    );
    return rows.length > 0;
  }

  async find(productId: string): Promise<ProductSnapshot | null> {
    const [row] = await this.sequelize.query<ProductSnapshot>(
      `SELECT "productId", "shopId", "title", "category", "priceMinor", "currency", "inStock", "status", "isSandbox",
              "productVersion"
         FROM "AdProductSnapshot" WHERE "productId" = :productId`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    return row ?? null;
  }
}

/** `AdShopSnapshot` (R3 read model of tenancy): served only while `ACTIVE`, not offboarding, not deleted. */
@Injectable()
export class SequelizeShopSnapshotStore implements ShopSnapshotStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async upsertIfNewer(snapshot: ShopSnapshot, now: Date): Promise<boolean> {
    const rows = await this.sequelize.query(
      `INSERT INTO "AdShopSnapshot" AS s ("shopId", "status", "offboarding", "deleted", "shopVersion", "updatedAt")
       VALUES (:shopId, :status, :offboarding, :deleted, :shopVersion, :now)
       ON CONFLICT ("shopId") DO UPDATE
          SET "status" = EXCLUDED."status", "offboarding" = EXCLUDED."offboarding", "deleted" = EXCLUDED."deleted",
              "shopVersion" = EXCLUDED."shopVersion", "updatedAt" = EXCLUDED."updatedAt"
        WHERE s."shopVersion" < EXCLUDED."shopVersion"
       RETURNING s."shopId"`,
      { type: QueryTypes.SELECT, replacements: { ...snapshot, now } },
    );
    return rows.length > 0;
  }

  async find(shopId: string): Promise<ShopSnapshot | null> {
    const [row] = await this.sequelize.query<ShopSnapshot>(
      `SELECT "shopId", "status", "offboarding", "deleted", "shopVersion" FROM "AdShopSnapshot" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    return row ?? null;
  }
}
