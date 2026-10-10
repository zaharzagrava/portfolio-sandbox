import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  InviteRecord,
  InviteRepository,
  InviteStatus,
} from '../../domain/ports';

const COLUMNS = `"id","shopId","email","role","tokenHash","invitedBy","expiresAt","acceptedAt","acceptedBy","revokedAt","createdAt",
  "createdAt"::text AS "cursorKey"`;

/** Postgres adapter of `INVITE_REPOSITORY`: the only code that touches `ShopInvite`. */
@Injectable()
export class SequelizeInviteRepository implements InviteRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async insert(input: {
    shopId: string;
    email: string;
    role: InviteRecord['role'];
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
    now: Date;
  }) {
    const [row] = await this.rows<InviteRecord>(
      `INSERT INTO "ShopInvite" ("shopId","email","role","tokenHash","invitedBy","expiresAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
      [
        input.shopId,
        input.email,
        input.role,
        input.tokenHash,
        input.invitedBy,
        input.expiresAt,
        input.now,
      ],
    );
    return row ?? null;
  }

  async find(shopId: string, id: string) {
    const [row] = await this.rows<InviteRecord>(
      `SELECT ${COLUMNS} FROM "ShopInvite" WHERE "shopId" = $1 AND "id" = $2`,
      [shopId, id],
    );
    return row ?? null;
  }

  async findPendingByEmail(shopId: string, email: string) {
    const [row] = await this.rows<InviteRecord>(
      `SELECT ${COLUMNS} FROM "ShopInvite"
       WHERE "shopId" = $1 AND lower("email") = lower($2) AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
      [shopId, email],
    );
    return row ?? null;
  }

  async countPending(shopId: string, now: Date) {
    const [row] = await this.rows<{ n: string }>(
      `SELECT count(*) AS "n" FROM "ShopInvite"
       WHERE "shopId" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > $2`,
      [shopId, now],
    );
    return Number(row.n);
  }

  async revoke(shopId: string, id: string, now: Date) {
    const updated = await this.rows(
      `UPDATE "ShopInvite" SET "revokedAt" = $3
       WHERE "shopId" = $1 AND "id" = $2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL RETURNING "id"`,
      [shopId, id, now],
    );
    return updated.length === 1;
  }

  async renew(shopId: string, id: string, tokenHash: string, expiresAt: Date) {
    const updated = await this.rows(
      `UPDATE "ShopInvite" SET "tokenHash" = $3, "expiresAt" = $4
       WHERE "shopId" = $1 AND "id" = $2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL RETURNING "id"`,
      [shopId, id, tokenHash, expiresAt],
    );
    return updated.length === 1;
  }

  listPage(
    shopId: string,
    status: InviteStatus | null,
    now: Date,
    after: { key: string; id: string } | null,
    limit: number,
  ) {
    return this.rows<InviteRecord>(
      `SELECT ${COLUMNS} FROM "ShopInvite"
       WHERE "shopId" = $1
         AND ($2::text IS NULL OR $2 = CASE
              WHEN "acceptedAt" IS NOT NULL THEN 'accepted'
              WHEN "revokedAt" IS NOT NULL THEN 'revoked'
              WHEN "expiresAt" <= $3 THEN 'expired'
              ELSE 'pending' END)
         AND ($4::timestamptz IS NULL OR ("createdAt","id") < ($4::timestamptz, $5::uuid))
       ORDER BY "createdAt" DESC, "id" DESC LIMIT $6`,
      [shopId, status, now, after?.key ?? null, after?.id ?? null, limit],
    );
  }

  async findByTokenHash(tokenHash: string) {
    const [row] = await this.rows<InviteRecord>(
      `SELECT ${COLUMNS} FROM "ShopInvite" WHERE "tokenHash" = $1`,
      [tokenHash],
    );
    return row ?? null;
  }

  async markAccepted(id: string, userId: string, now: Date) {
    const updated = await this.rows(
      `UPDATE "ShopInvite" SET "acceptedAt" = $3, "acceptedBy" = $2
       WHERE "id" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > $3 RETURNING "id"`,
      [id, userId, now],
    );
    return updated.length === 1;
  }
}
