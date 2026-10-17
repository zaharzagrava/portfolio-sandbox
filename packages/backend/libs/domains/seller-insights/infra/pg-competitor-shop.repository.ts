import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import type {
  CompetitorShopRecord,
  CompetitorShopRepository,
} from '../domain/crawler-ports';

/** The shop read model (R3): written only by the shop consumer, version-guarded by the service that calls it. */
@Injectable()
export class PgCompetitorShopRepository implements CompetitorShopRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(shopId: string, forUpdate = false) {
    const [row] = await this.sequelize.query<CompetitorShopRecord>(
      `SELECT "shopId", "plan", "status", "version" FROM "CompetitorShop" WHERE "shopId" = :shopId${forUpdate ? ' FOR UPDATE' : ''}`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    return row ?? null;
  }

  async findMany(shopIds: string[]) {
    if (shopIds.length === 0) return new Map<string, CompetitorShopRecord>();
    const rows = await this.sequelize.query<CompetitorShopRecord>(
      `SELECT "shopId", "plan", "status", "version" FROM "CompetitorShop" WHERE "shopId" IN (:shopIds)`,
      { type: QueryTypes.SELECT, replacements: { shopIds } },
    );
    return new Map(rows.map((r) => [r.shopId, r]));
  }

  async upsert(record: CompetitorShopRecord, now: Date) {
    await this.sequelize.query(
      `INSERT INTO "CompetitorShop" ("shopId", "plan", "status", "version", "updatedAt")
       VALUES (:shopId, :plan, :status, :version, :now)
       ON CONFLICT ("shopId") DO UPDATE
         SET "plan" = EXCLUDED."plan", "status" = EXCLUDED."status", "version" = EXCLUDED."version",
             "updatedAt" = EXCLUDED."updatedAt"`,
      { replacements: { ...record, now } },
    );
  }

  async remove(shopId: string) {
    await this.sequelize.query(
      `DELETE FROM "CompetitorShop" WHERE "shopId" = :shopId`,
      { replacements: { shopId } },
    );
  }
}
