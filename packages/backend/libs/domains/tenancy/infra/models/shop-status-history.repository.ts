import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { StatusHistoryRepository } from '../../domain/ports';
import type { ShopStatus } from '../../domain/shop-status';

/** Postgres adapter of `STATUS_HISTORY_REPOSITORY`: the only code that touches `ShopStatusHistory`. */
@Injectable()
export class SequelizeStatusHistoryRepository implements StatusHistoryRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async insert(input: {
    shopId: string;
    from: ShopStatus | null;
    to: ShopStatus;
    actor: string;
    reason: string | null;
    at: Date;
  }) {
    await this.sequelize.query(
      `INSERT INTO "ShopStatusHistory" ("shopId","from","to","actor","reason","at") VALUES ($1,$2,$3,$4,$5,$6)`,
      {
        bind: [
          input.shopId,
          input.from,
          input.to,
          input.actor,
          input.reason,
          input.at,
        ],
        transaction: getActiveTransaction(),
      },
    );
  }
}
