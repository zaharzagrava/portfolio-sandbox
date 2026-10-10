import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  StockOperationRecord,
  StockOperationRepository,
} from '../domain/ports';

/** Postgres adapter of `StockOperationRepository`: the operation id is the idempotency key (unique primary key). */
@Injectable()
export class SequelizeStockOperationRepository implements StockOperationRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async findMany(operationIds: string[]): Promise<StockOperationRecord[]> {
    if (operationIds.length === 0) return [];
    return this.sequelize.query<StockOperationRecord>(
      `SELECT "operationId","productId","shopId","delta","reason","quantityAfter","productVersion","appliedAt"
       FROM "ProductStockOperation" WHERE "operationId" = ANY($1::text[])`,
      {
        bind: [operationIds],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
  }

  async insert(record: StockOperationRecord): Promise<boolean> {
    const rows = await this.sequelize.query<{ operationId: string }>(
      `INSERT INTO "ProductStockOperation"
         ("operationId","productId","shopId","delta","reason","quantityAfter","productVersion","appliedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT ("operationId") DO NOTHING RETURNING "operationId"`,
      {
        bind: [
          record.operationId,
          record.productId,
          record.shopId,
          record.delta,
          record.reason,
          record.quantityAfter,
          record.productVersion,
          record.appliedAt,
        ],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.length === 1;
  }

  async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.sequelize.query<{ operationId: string }>(
      `DELETE FROM "ProductStockOperation" WHERE "operationId" IN (
         SELECT "operationId" FROM "ProductStockOperation" WHERE "appliedAt" < $1 ORDER BY "appliedAt" LIMIT $2)
       RETURNING "operationId"`,
      {
        bind: [cutoff, limit],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.length;
  }
}
