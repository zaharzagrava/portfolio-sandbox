import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { UsageRepository } from '../domain/ports';
import { count, exec, num, one, rows } from './sql';

/** `AssetShopUsage` (own table): stored plus reserved bytes per shop, the quota check is one conditional update (D5). */
@Injectable()
export class SequelizeUsageRepository implements UsageRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async ensure(shopId: string): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetShopUsage" ("shopId") VALUES ($shopId) ON CONFLICT ("shopId") DO NOTHING`,
      { shopId },
    );
  }

  async reserve(
    shopId: string,
    bytes: number,
    quotaBytes: number,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "AssetShopUsage" SET "reservedBytes" = "reservedBytes" + $bytes::bigint
          WHERE "shopId" = $shopId AND "storedBytes" + "reservedBytes" + $bytes::bigint <= $quotaBytes::bigint
        RETURNING 1`,
        { shopId, bytes, quotaBytes },
      )) > 0
    );
  }

  async used(
    shopId: string,
  ): Promise<{ storedBytes: number; reservedBytes: number }> {
    const r = await one<{ storedBytes: string; reservedBytes: string }>(
      this.db,
      `SELECT "storedBytes", "reservedBytes" FROM "AssetShopUsage" WHERE "shopId" = $shopId`,
      { shopId },
    );
    return {
      storedBytes: num(r?.storedBytes),
      reservedBytes: num(r?.reservedBytes),
    };
  }

  async adjust(
    shopId: string,
    delta: { storedBytes: number; reservedBytes: number },
  ): Promise<void> {
    if (delta.storedBytes === 0 && delta.reservedBytes === 0) return;
    await exec(
      this.db,
      `UPDATE "AssetShopUsage"
          SET "storedBytes" = "storedBytes" + $stored::bigint, "reservedBytes" = "reservedBytes" + $reserved::bigint
        WHERE "shopId" = $shopId`,
      { shopId, stored: delta.storedBytes, reserved: delta.reservedBytes },
    );
  }

  async tiers(): Promise<
    {
      tier: 'small' | 'medium' | 'large';
      storedBytes: number;
      reservedBytes: number;
    }[]
  > {
    const found = await rows<{
      tier: 'small' | 'medium' | 'large';
      stored: string;
      reserved: string;
    }>(
      this.db,
      `SELECT CASE WHEN "storedBytes" < 1073741824 THEN 'small'
                   WHEN "storedBytes" < 10737418240 THEN 'medium' ELSE 'large' END AS tier,
              sum("storedBytes") AS stored, sum("reservedBytes") AS reserved
         FROM "AssetShopUsage" GROUP BY 1`,
    );
    return found.map((r) => ({
      tier: r.tier,
      storedBytes: num(r.stored),
      reservedBytes: num(r.reserved),
    }));
  }

  async remove(shopId: string): Promise<void> {
    await exec(
      this.db,
      `DELETE FROM "AssetShopUsage" WHERE "shopId" = $shopId`,
      {
        shopId,
      },
    );
  }
}
