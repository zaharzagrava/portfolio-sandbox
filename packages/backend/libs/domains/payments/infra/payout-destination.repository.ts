import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  DestinationRecord,
  PayoutDestinationRepository,
} from '../domain/payout-ports';

const COLUMNS = `"shopId", "providerAccountId", "effectiveFrom", "changedAt", "changedBy", "version"`;

/** The payout destination table and its masked history (S15 data-model.md). The full id never leaves this class but through `find`. */
@Injectable()
export class SequelizePayoutDestinationRepository implements PayoutDestinationRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(
    shopId: string,
    tx?: Transaction,
  ): Promise<DestinationRecord | null> {
    const rows = await this.sequelize.query<DestinationRecord>(
      `SELECT ${COLUMNS} FROM "PayoutDestination" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId }, transaction: tx },
    );
    return rows[0] ?? null;
  }

  async findMany(shopIds: string[]): Promise<Map<string, DestinationRecord>> {
    if (shopIds.length === 0) return new Map();
    const rows = await this.sequelize.query<DestinationRecord>(
      `SELECT ${COLUMNS} FROM "PayoutDestination" WHERE "shopId" IN (:shopIds)`,
      { type: QueryTypes.SELECT, replacements: { shopIds } },
    );
    return new Map(rows.map((r) => [r.shopId, r]));
  }

  async save(
    record: Omit<DestinationRecord, 'version'>,
    fromMasked: string | null,
    toMasked: string,
    tx: Transaction,
  ): Promise<DestinationRecord> {
    const rows = await this.sequelize.query<DestinationRecord>(
      `INSERT INTO "PayoutDestination" (${COLUMNS})
       VALUES (:shopId, :providerAccountId, :effectiveFrom, :changedAt, :changedBy, 1)
       ON CONFLICT ("shopId") DO UPDATE SET "providerAccountId" = EXCLUDED."providerAccountId",
         "effectiveFrom" = EXCLUDED."effectiveFrom", "changedAt" = EXCLUDED."changedAt",
         "changedBy" = EXCLUDED."changedBy", "version" = "PayoutDestination"."version" + 1
       RETURNING ${COLUMNS}`,
      { type: QueryTypes.SELECT, replacements: { ...record }, transaction: tx },
    );
    await this.sequelize.query(
      `INSERT INTO "PayoutDestinationHistory" ("shopId", "fromMasked", "toMasked", "effectiveFrom", "at", "actor")
       VALUES (:shopId, :fromMasked, :toMasked, :effectiveFrom, :changedAt, :changedBy)`,
      {
        transaction: tx,
        replacements: { ...record, fromMasked, toMasked },
      },
    );
    return rows[0];
  }
}
