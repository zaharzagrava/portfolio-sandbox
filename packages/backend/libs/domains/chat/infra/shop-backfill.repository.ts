import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { LegacyChannel, ShopBackfillRepository } from '../domain/ports';
import { select } from './sql';

/** Channels created before shops existed (S24 FR-044). */
@Injectable()
export class SequelizeShopBackfillRepository implements ShopBackfillRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  unassigned(afterId: string | null, limit: number): Promise<LegacyChannel[]> {
    return select<LegacyChannel>(
      this.sequelize,
      `SELECT id, "productId", "sellerId" FROM "ChatChannel"
        WHERE "shopId" IS NULL AND (CAST(:afterId AS uuid) IS NULL OR id > CAST(:afterId AS uuid))
        ORDER BY id LIMIT :limit`,
      { afterId, limit },
    );
  }

  async assign(channelId: string, shopId: string): Promise<boolean> {
    const rows = await select<object>(
      this.sequelize,
      `UPDATE "ChatChannel" SET "shopId" = :shopId WHERE id = :channelId AND "shopId" IS NULL RETURNING 1 AS one`,
      { channelId, shopId },
    );
    return rows.length === 1;
  }

  async remaining(): Promise<number> {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*)::text AS n FROM "ChatChannel" WHERE "shopId" IS NULL`,
    );
    return Number(row?.n ?? 0);
  }

  /**
   * The migration left a `CHECK ("shopId" IS NOT NULL) NOT VALID` (new rows must have a shop). Once no channel is
   * without one, the constraint is validated (a scan without a long lock), the column becomes NOT NULL (which reuses the
   * validated constraint, no second scan) and the check is dropped.
   */
  async requireShop(): Promise<boolean> {
    if ((await this.remaining()) > 0) return false;
    await this.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatChannel_shop_required' AND conrelid = '"ChatChannel"'::regclass) THEN
          ALTER TABLE "ChatChannel" VALIDATE CONSTRAINT "ChatChannel_shop_required";
        END IF;
        ALTER TABLE "ChatChannel" ALTER COLUMN "shopId" SET NOT NULL;
        ALTER TABLE "ChatChannel" DROP CONSTRAINT IF EXISTS "ChatChannel_shop_required";
      END $$;
    `);
    return true;
  }
}
