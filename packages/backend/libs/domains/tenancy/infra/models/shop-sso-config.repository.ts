import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { SsoConfigRecord, SsoConfigRepository } from '../../domain/ports';

const COLUMNS = `"shopId","issuer","clientId","clientSecretEnc","defaultRole","enabled","updatedAt"`;

/** Postgres adapter of `SSO_CONFIG_REPOSITORY`: the only code that touches `ShopSsoConfig`. */
@Injectable()
export class SequelizeSsoConfigRepository implements SsoConfigRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select(text: string, bind: unknown[]) {
    return this.sequelize.query<SsoConfigRecord>(text, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async find(shopId: string) {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "ShopSsoConfig" WHERE "shopId" = $1`,
      [shopId],
    );
    return row ?? null;
  }

  async upsert(input: {
    shopId: string;
    issuer: string;
    clientId: string;
    clientSecretEnc: string;
    defaultRole: 'STAFF' | 'VIEWER';
    now: Date;
  }) {
    const [row] = await this.select(
      `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","defaultRole","enabled","updatedAt")
       VALUES ($1,$2,$3,$4,$5,true,$6)
       ON CONFLICT ("shopId") DO UPDATE SET "issuer" = EXCLUDED."issuer", "clientId" = EXCLUDED."clientId",
         "clientSecretEnc" = EXCLUDED."clientSecretEnc", "defaultRole" = EXCLUDED."defaultRole", "enabled" = true,
         "updatedAt" = EXCLUDED."updatedAt"
       RETURNING ${COLUMNS}`,
      [
        input.shopId,
        input.issuer,
        input.clientId,
        input.clientSecretEnc,
        input.defaultRole,
        input.now,
      ],
    );
    return row;
  }

  async delete(shopId: string) {
    const rows = await this.select(
      `DELETE FROM "ShopSsoConfig" WHERE "shopId" = $1 RETURNING "shopId"`,
      [shopId],
    );
    return rows.length > 0;
  }

  listLegacySealed(limit: number) {
    return this.select(
      `SELECT ${COLUMNS} FROM "ShopSsoConfig" WHERE "clientSecretEnc" LIKE 'v1.%' ORDER BY "shopId" LIMIT $1`,
      [limit],
    );
  }

  async replaceSealed(shopId: string, from: string, to: string) {
    const rows = await this.select(
      `UPDATE "ShopSsoConfig" SET "clientSecretEnc" = $3 WHERE "shopId" = $1 AND "clientSecretEnc" = $2 RETURNING "shopId"`,
      [shopId, from, to],
    );
    return rows.length > 0;
  }
}
