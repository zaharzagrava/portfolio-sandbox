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

  async applyChunk(
    batchId: string,
    chunk: number,
    ids: string[],
    deltas: number[],
  ): Promise<boolean> {
    const transaction = getActiveTransaction();
    const marker = await this.sequelize.query(
      `INSERT INTO "ProductViewBatch" ("batchId","chunk","appliedAt") VALUES ($1,$2,now())
       ON CONFLICT ("batchId","chunk") DO NOTHING RETURNING "batchId"`,
      { bind: [batchId, chunk], transaction, type: QueryTypes.SELECT },
    );
    if (marker.length === 0) return false;
    await this.sequelize.query(
      `UPDATE "Product" p SET "viewCount" = p."viewCount" + d.delta
       FROM unnest($1::uuid[], $2::bigint[]) AS d(id, delta)
       WHERE p.id = d.id`,
      { bind: [ids, deltas], transaction },
    );
    return true;
  }

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
