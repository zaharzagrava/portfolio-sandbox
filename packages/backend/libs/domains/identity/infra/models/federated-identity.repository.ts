import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  FederatedIdentityRecord,
  FederatedIdentityRepository,
} from '../../domain/ports';

const PROVIDER_SHAPE =
  /^(google|shop:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres adapter of `FEDERATED_IDENTITY_REPOSITORY`, the only code that touches `FederatedIdentity` (III.1). An
 * insert that meets a unique index answers `null` (`ON CONFLICT DO NOTHING`) instead of raising: inside the linking
 * transaction a raised violation would abort the whole transaction.
 */
@Injectable()
export class SequelizeFederatedIdentityRepository implements FederatedIdentityRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async findByProviderSubject(provider: string, subject: string) {
    const [row] = await this.rows<
      FederatedIdentityRecord & { userDeleted: boolean }
    >(
      `SELECT f.*, (u."id" IS NULL OR u."deletedAt" IS NOT NULL) AS "userDeleted"
       FROM "FederatedIdentity" f LEFT JOIN "User" u ON u."id" = f."userId"
       WHERE f."provider" = $1 AND f."subject" = $2`,
      [provider, subject],
    );
    return row ?? null;
  }

  async findByUserProvider(userId: string, provider: string) {
    const [row] = await this.rows<FederatedIdentityRecord>(
      `SELECT * FROM "FederatedIdentity" WHERE "userId" = $1 AND "provider" = $2`,
      [userId, provider],
    );
    return row ?? null;
  }

  listForUser(userId: string) {
    return this.rows<FederatedIdentityRecord>(
      `SELECT * FROM "FederatedIdentity" WHERE "userId" = $1 ORDER BY "createdAt", "id"`,
      [userId],
    );
  }

  async insert(input: {
    userId: string;
    provider: string;
    subject: string;
    email: string | null;
    wipePending: boolean;
  }) {
    if (!PROVIDER_SHAPE.test(input.provider))
      throw new Error('unsupported provider shape');
    const [row] = await this.rows<FederatedIdentityRecord>(
      `INSERT INTO "FederatedIdentity" ("userId","provider","subject","email","wipePending","createdAt")
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.provider,
        input.subject,
        input.email,
        input.wipePending,
      ],
    );
    return row ?? null;
  }

  async deleteOwned(id: string, userId: string) {
    if (!UUID.test(id)) return null;
    const [row] = await this.rows<{ provider: string }>(
      `DELETE FROM "FederatedIdentity" WHERE "id" = $1 AND "userId" = $2 RETURNING "provider"`,
      [id, userId],
    );
    return row ?? null;
  }

  async countLoginMethods(userId: string): Promise<number> {
    const [row] = await this.rows<{ n: string }>(
      `SELECT (SELECT count(*) FROM "FederatedIdentity" WHERE "userId" = $1)
            + (SELECT count(*) FROM "User" WHERE "id" = $1 AND "passwordHash" IS NOT NULL) AS n`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }

  async markWipeDone(id: string): Promise<boolean> {
    const rows = await this.rows(
      `UPDATE "FederatedIdentity" SET "wipePending" = false
       WHERE "id" = $1 AND "wipePending" RETURNING "id"`,
      [id],
    );
    return rows.length === 1;
  }
}
