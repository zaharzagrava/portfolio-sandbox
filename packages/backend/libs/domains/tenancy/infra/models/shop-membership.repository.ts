import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type {
  MemberRow,
  MembershipReader,
  MembershipRepository,
} from '../../domain/ports';
import type { ShopRole } from '../../domain/shop-types';
import type { ShopStatus } from '../../domain/shop-status';

/**
 * Postgres adapter of `MEMBERSHIP_REPOSITORY` and `MEMBERSHIP_READER`: the only code that touches `ShopMembership`.
 * Callers run inside `ShopTransactionRunner` (shop or user context) so row-level security sees the tenant.
 */
@Injectable()
export class SequelizeMembershipRepository
  implements MembershipRepository, MembershipReader
{
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
    userId: string;
    role: ShopRole;
    source: MemberRow['source'];
    now: Date;
  }) {
    const inserted = await this.rows(
      `INSERT INTO "ShopMembership" ("shopId","userId","role","source","createdAt") VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT ("shopId","userId") DO NOTHING RETURNING "userId"`,
      [input.shopId, input.userId, input.role, input.source, input.now],
    );
    return inserted.length === 1;
  }

  async find(shopId: string, userId: string) {
    const [row] = await this.rows<MemberRow>(
      `SELECT "userId","role","source","createdAt" AS "joinedAt","createdAt"::text AS "cursorKey"
       FROM "ShopMembership" WHERE "shopId" = $1 AND "userId" = $2`,
      [shopId, userId],
    );
    return row ?? null;
  }

  listPage(
    shopId: string,
    after: { key: string; id: string } | null,
    limit: number,
  ) {
    return this.rows<MemberRow>(
      `SELECT "userId","role","source","createdAt" AS "joinedAt","createdAt"::text AS "cursorKey"
       FROM "ShopMembership"
       WHERE "shopId" = $1 AND ($2::timestamptz IS NULL OR ("createdAt","userId") > ($2::timestamptz, $3::uuid))
       ORDER BY "createdAt","userId" LIMIT $4`,
      [shopId, after?.key ?? null, after?.id ?? null, limit],
    );
  }

  async count(shopId: string) {
    const [row] = await this.rows<{ n: string }>(
      `SELECT count(*) AS "n" FROM "ShopMembership" WHERE "shopId" = $1`,
      [shopId],
    );
    return Number(row.n);
  }

  async countOwners(shopId: string) {
    const [row] = await this.rows<{ n: string }>(
      `SELECT count(*) AS "n" FROM "ShopMembership" WHERE "shopId" = $1 AND "role" = 'OWNER'`,
      [shopId],
    );
    return Number(row.n);
  }

  async updateRole(
    shopId: string,
    userId: string,
    from: ShopRole,
    to: ShopRole,
  ) {
    const updated = await this.rows(
      `UPDATE "ShopMembership" SET "role" = $4 WHERE "shopId" = $1 AND "userId" = $2 AND "role" = $3 RETURNING "userId"`,
      [shopId, userId, from, to],
    );
    return updated.length === 1;
  }

  async delete(shopId: string, userId: string, role: ShopRole) {
    const deleted = await this.rows(
      `DELETE FROM "ShopMembership" WHERE "shopId" = $1 AND "userId" = $2 AND "role" = $3 RETURNING "userId"`,
      [shopId, userId, role],
    );
    return deleted.length === 1;
  }

  listByShopIds(shopIds: string[], roles?: ShopRole[]) {
    if (shopIds.length === 0) return Promise.resolve([]);
    return this.rows<{ shopId: string; userId: string; role: ShopRole }>(
      `SELECT "shopId","userId","role" FROM "ShopMembership"
       WHERE "shopId" = ANY($1::uuid[]) AND ($2::text[] IS NULL OR "role" = ANY($2::text[]))
       ORDER BY "shopId","createdAt","userId"`,
      [[...new Set(shopIds)], roles ?? null],
    );
  }

  async read(shopId: string, userId: string) {
    const [row] = await this.rows<{ role: ShopRole; status: ShopStatus }>(
      `SELECT m."role", s."status" FROM "ShopMembership" m JOIN "Shop" s ON s."id" = m."shopId"
       WHERE m."shopId" = $1 AND m."userId" = $2`,
      [shopId, userId],
    );
    return row ?? null;
  }
}
