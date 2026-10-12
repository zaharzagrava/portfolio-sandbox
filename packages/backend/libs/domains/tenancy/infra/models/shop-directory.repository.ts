import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { DirectoryRecord, DirectoryRepository } from '../../domain/ports';

/** Postgres adapter of `DIRECTORY_REPOSITORY`: the only code that touches `ShopDirectory`. */
@Injectable()
export class SequelizeDirectoryRepository implements DirectoryRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async insert(shopId: string, cell: string, region: string, now: Date) {
    await this.sequelize.query(
      `INSERT INTO "ShopDirectory" ("shopId","cell","region","updatedAt") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("shopId") DO NOTHING`,
      {
        bind: [shopId, cell, region, now],
        transaction: getActiveTransaction(),
      },
    );
  }

  async delete(shopId: string): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "ShopDirectory" WHERE "shopId" = $1`,
      { bind: [shopId], transaction: getActiveTransaction() },
    );
  }

  async move(input: {
    shopId: string;
    expectedVersion: number;
    cell: string;
    region: string;
    now: Date;
  }): Promise<DirectoryRecord | null> {
    const [row] = await this.sequelize.query<
      Omit<DirectoryRecord, 'version'> & { version: string }
    >(
      `UPDATE "ShopDirectory" SET "cell" = $3, "region" = $4, "version" = "version" + 1, "updatedAt" = $5
       WHERE "shopId" = $1 AND "version" = $2
       RETURNING "shopId","cell","region","version"`,
      {
        bind: [
          input.shopId,
          input.expectedVersion,
          input.cell,
          input.region,
          input.now,
        ],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return row ? { ...row, version: Number(row.version) } : null;
  }

  async find(shopId: string): Promise<DirectoryRecord | null> {
    const [row] = await this.sequelize.query<
      Omit<DirectoryRecord, 'version'> & { version: string }
    >(
      `SELECT "shopId","cell","region","version" FROM "ShopDirectory" WHERE "shopId" = $1`,
      {
        bind: [shopId],
        transaction: getActiveTransaction(),
        type: QueryTypes.SELECT,
      },
    );
    return row ? { ...row, version: Number(row.version) } : null;
  }
}
