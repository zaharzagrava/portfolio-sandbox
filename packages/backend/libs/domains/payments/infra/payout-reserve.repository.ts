import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  PayoutReserveRepository,
  ReserveRecord,
} from '../domain/payout-ports';

const COLUMNS = `"shopId", "reserveBps", "reason", "updatedBy", "updatedAt"`;

/** Per-shop reserve overrides and their append-only history (S15 data-model.md). */
@Injectable()
export class SequelizePayoutReserveRepository implements PayoutReserveRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(shopId: string, tx?: Transaction): Promise<ReserveRecord | null> {
    const rows = await this.sequelize.query<ReserveRecord>(
      `SELECT ${COLUMNS} FROM "PayoutReserve" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId }, transaction: tx },
    );
    return rows[0] ?? null;
  }

  async findMany(shopIds: string[]): Promise<Map<string, ReserveRecord>> {
    if (shopIds.length === 0) return new Map();
    const rows = await this.sequelize.query<ReserveRecord>(
      `SELECT ${COLUMNS} FROM "PayoutReserve" WHERE "shopId" IN (:shopIds)`,
      { type: QueryTypes.SELECT, replacements: { shopIds } },
    );
    return new Map(rows.map((r) => [r.shopId, r]));
  }

  async save(record: ReserveRecord, tx: Transaction): Promise<ReserveRecord> {
    const previous = await this.find(record.shopId, tx);
    if (
      previous &&
      previous.reserveBps === record.reserveBps &&
      previous.reason === record.reason
    )
      return previous;
    await this.sequelize.query(
      `INSERT INTO "PayoutReserve" (${COLUMNS})
       VALUES (:shopId, :reserveBps, :reason, :updatedBy, :updatedAt)
       ON CONFLICT ("shopId") DO UPDATE SET "reserveBps" = EXCLUDED."reserveBps", "reason" = EXCLUDED."reason",
         "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = EXCLUDED."updatedAt"`,
      { transaction: tx, replacements: { ...record } },
    );
    await this.sequelize.query(
      `INSERT INTO "PayoutReserveHistory" ("shopId", "previousBps", "reserveBps", "reason", "actor", "at")
       VALUES (:shopId, :previousBps, :reserveBps, :reason, :updatedBy, :updatedAt)`,
      {
        transaction: tx,
        replacements: { ...record, previousBps: previous?.reserveBps ?? null },
      },
    );
    return record;
  }
}
