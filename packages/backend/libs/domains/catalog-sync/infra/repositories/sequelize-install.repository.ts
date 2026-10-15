import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { InstallRecord, InstallRepository } from '../../domain/ports';
import { count, one, toDate, toDateRequired } from './sql';

const INSTALL_TTL_MS = 10 * 60_000;
const COLUMNS = `"id", "shopId", "userId", "shopDomain", "expiresAt", "consumedAt", "createdAt"`;

function toInstall(r: Record<string, unknown>): InstallRecord {
  return {
    id: r.id as string,
    shopId: r.shopId as string,
    userId: r.userId as string,
    shopDomain: r.shopDomain as string,
    expiresAt: toDateRequired(r.expiresAt),
    consumedAt: toDate(r.consumedAt),
    createdAt: toDateRequired(r.createdAt),
  };
}

/** `IntegrationInstall` (own table): single-use OAuth state, only its SHA-256 digest is stored. */
@Injectable()
export class SequelizeInstallRepository implements InstallRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async create(
    input: {
      shopId: string;
      userId: string;
      shopDomain: string;
      stateDigest: string;
    },
    now: Date,
  ): Promise<InstallRecord> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `INSERT INTO "IntegrationInstall" ("shopId", "userId", "shopDomain", "stateDigest", "expiresAt", "createdAt")
       VALUES (:shopId, :userId, :shopDomain, :stateDigest, :expiresAt, :now) RETURNING ${COLUMNS}`,
      { ...input, now, expiresAt: new Date(now.getTime() + INSTALL_TTL_MS) },
    );
    return toInstall(r as Record<string, unknown>);
  }

  async consume(stateDigest: string, now: Date): Promise<InstallRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "IntegrationInstall" SET "consumedAt" = :now
        WHERE "stateDigest" = :stateDigest AND "consumedAt" IS NULL AND "expiresAt" > :now
        RETURNING ${COLUMNS}`,
      { stateDigest, now },
    );
    return r && toInstall(r);
  }

  purgeExpiredBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "IntegrationInstall"
        WHERE "id" IN (SELECT "id" FROM "IntegrationInstall" WHERE "expiresAt" < :before ORDER BY "expiresAt" LIMIT :limit) RETURNING 1`,
      { before, limit },
    );
  }
}
