import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { ShopCopyFacts } from '../domain/offer-document';
import type { ShopCopyStore } from '../domain/pickup-ports';

/**
 * `PickupShopCopy`: whether a shop may sell, built from `tenancy.shop_created|shop_status_changed|shop_deleted`
 * (S19 FR-032). Written only when the event's `shopVersion` is greater than the stored one. A shop without a row is
 * not visible (fail closed).
 */
@Injectable()
export class ShopCopySqlStore implements ShopCopyStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async upsert(copy: ShopCopyFacts): Promise<boolean> {
    const rows = await this.sequelize.query(
      `INSERT INTO "PickupShopCopy" AS c ("shopId", "status", "version", "updatedAt")
       VALUES (:shopId, :status, :version, now())
       ON CONFLICT ("shopId") DO UPDATE SET "status" = EXCLUDED."status", "version" = EXCLUDED."version", "updatedAt" = now()
        WHERE c."version" < EXCLUDED."version"
       RETURNING c."shopId"`,
      { type: QueryTypes.SELECT, replacements: { ...copy } },
    );
    return rows.length > 0;
  }

  async find(shopId: string): Promise<ShopCopyFacts | null> {
    const [row] = await this.sequelize.query<
      Omit<ShopCopyFacts, 'version'> & { version: string }
    >(
      `SELECT "shopId", "status", "version" FROM "PickupShopCopy" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    return row ? { ...row, version: Number(row.version) } : null;
  }
}
