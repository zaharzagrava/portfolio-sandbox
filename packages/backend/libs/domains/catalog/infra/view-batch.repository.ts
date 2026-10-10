import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { ViewBatchRepository } from '../domain/ports';

/** Postgres adapter of `ViewBatchRepository`: markers of the applied chunks of a view flush (`ProductViewBatch`). */
@Injectable()
export class SequelizeViewBatchRepository implements ViewBatchRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.sequelize.query<{ batchId: string }>(
      `DELETE FROM "ProductViewBatch" WHERE "appliedAt" < $1 RETURNING "batchId"`,
      {
        bind: [cutoff],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return rows.length;
  }
}
