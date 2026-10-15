import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { SYNC_FIELDS, type SyncField } from '@marketplace-sandbox/contracts';
import type { FieldClocks, SyncFieldClockRepository } from '../../domain/ports';
import { count, rows } from './sql';

/** `ProductFieldClock` (own table); a clock is never read or written without its shop. */
@Injectable()
export class SequelizeFieldClockRepository implements SyncFieldClockRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async read(shopId: string, productId: string): Promise<FieldClocks> {
    const found = await rows<{ field: string; hlc: string }>(
      this.db,
      `SELECT "field", "hlc" FROM "ProductFieldClock" WHERE "shopId" = :shopId AND "productId" = :productId`,
      { shopId, productId },
    );
    const clocks: FieldClocks = {};
    for (const r of found)
      if ((SYNC_FIELDS as readonly string[]).includes(r.field))
        clocks[r.field as SyncField] = r.hlc;
    return clocks;
  }

  async advance(
    shopId: string,
    productId: string,
    clocks: FieldClocks,
  ): Promise<void> {
    for (const [field, hlc] of Object.entries(clocks))
      await count(
        this.db,
        `INSERT INTO "ProductFieldClock" ("shopId", "productId", "field", "hlc", "updatedAt")
         VALUES (:shopId, :productId, :field, :hlc, now())
         ON CONFLICT ("shopId", "productId", "field")
         DO UPDATE SET "hlc" = EXCLUDED."hlc", "updatedAt" = now()
         WHERE "ProductFieldClock"."hlc" COLLATE "C" < EXCLUDED."hlc" COLLATE "C"
         RETURNING 1`,
        { shopId, productId, field, hlc },
      );
  }

  deleteProduct(shopId: string, productId: string): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "ProductFieldClock" WHERE "shopId" = :shopId AND "productId" = :productId RETURNING 1`,
      { shopId, productId },
    );
  }

  deleteShop(shopId: string, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "ProductFieldClock" WHERE ctid IN (
         SELECT ctid FROM "ProductFieldClock" WHERE "shopId" = :shopId LIMIT :limit) RETURNING 1`,
      { shopId, limit },
    );
  }
}
