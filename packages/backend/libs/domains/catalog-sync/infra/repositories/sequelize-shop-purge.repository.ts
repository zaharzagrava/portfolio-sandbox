import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { ShopPurgeRepository } from '../../domain/ports';
import { count } from './sql';

const OF_SHOP = `(SELECT "id" FROM "Integration" WHERE "shopId" = :shopId)`;

/** Children first, each by the integrations of the shop; the integrations themselves last, so a resumed purge finds them. */
const STATEMENTS: Array<{ table: string; sql: (limit: string) => string }> = [
  ...[
    'ExternalLink',
    'SyncRun',
    'SyncCursor',
    'SyncQuarantine',
    'StockConflict',
    'CatalogReconciliationRun',
    'WebhookReceipt',
    'IntegrationHistory',
  ].map((table) => ({
    table,
    sql: (limit: string) =>
      `DELETE FROM "${table}" WHERE ctid IN (SELECT ctid FROM "${table}" WHERE "integrationId" IN ${OF_SHOP} LIMIT ${limit}) RETURNING 1`,
  })),
  {
    table: 'IntegrationInstall',
    sql: (limit) =>
      `DELETE FROM "IntegrationInstall" WHERE ctid IN (SELECT ctid FROM "IntegrationInstall" WHERE "shopId" = :shopId LIMIT ${limit}) RETURNING 1`,
  },
  {
    table: 'Integration',
    sql: (limit) =>
      `DELETE FROM "Integration" WHERE ctid IN (SELECT ctid FROM "Integration" WHERE "shopId" = :shopId LIMIT ${limit}) RETURNING 1`,
  },
];

/** Raw SQL on this capability's own tables (IX.4). Every statement is its own transaction of at most `limit` rows. */
@Injectable()
export class SequelizeShopPurgeRepository implements ShopPurgeRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  eraseCredentials(shopId: string): Promise<number> {
    return count(
      this.db,
      `UPDATE "Integration" SET "credentialsSealed" = NULL, "updatedAt" = now()
        WHERE "shopId" = :shopId AND "credentialsSealed" IS NOT NULL RETURNING 1`,
      { shopId },
    );
  }

  async deleteBatch(
    shopId: string,
    limit: number,
  ): Promise<{ table: string | null; deleted: number }> {
    const bounded = String(Math.max(1, Math.min(1_000, Math.floor(limit))));
    for (const statement of STATEMENTS) {
      const deleted = await count(this.db, statement.sql(bounded), { shopId });
      if (deleted > 0) return { table: statement.table, deleted };
    }
    return { table: null, deleted: 0 };
  }
}
