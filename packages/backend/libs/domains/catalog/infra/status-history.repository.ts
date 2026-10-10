import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  StatusHistoryEntry,
  StatusHistoryRepository,
} from '../domain/ports';

/** Append-only `ProductStatusHistory`; written in the transaction of the transition it records (III.7). */
@Injectable()
export class SequelizeStatusHistoryRepository implements StatusHistoryRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async append(entry: StatusHistoryEntry): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "ProductStatusHistory" ("productId","shopId","fromStatus","toStatus","productVersion","actorId","at")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      {
        bind: [
          entry.productId,
          entry.shopId,
          entry.fromStatus,
          entry.toStatus,
          entry.productVersion,
          entry.actorId,
          entry.at,
        ],
        transaction: getActiveTransaction(),
      },
    );
  }
}
