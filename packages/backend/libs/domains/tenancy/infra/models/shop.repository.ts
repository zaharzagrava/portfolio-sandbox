import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { getActiveTransaction } from '@app/infrastructure/context';
import type { ShopPlan } from '../../domain/shop-types';
import type {
  ShopListRow,
  ShopRecord,
  ShopRepository,
} from '../../domain/ports';

const SELECT = `s."id", s."slug", s."name", s."plan", s."planVersion", s."status", s."purgeAt", s."shopVersion",
  s."verificationStatus", s."payoutsEnabled", s."sandboxOf", s."createdAt",
  COALESCE(d."region", 'eu-central-1') AS "region"`;
const FROM = `"Shop" s LEFT JOIN "ShopDirectory" d ON d."shopId" = s."id"`;

type Row = Omit<ShopRecord, 'planVersion' | 'shopVersion'> & {
  planVersion: string;
  shopVersion: string;
};
const toRecord = (row: Row): ShopRecord => ({
  ...row,
  planVersion: Number(row.planVersion),
  shopVersion: Number(row.shopVersion),
});

/** Postgres adapter of `SHOP_REPOSITORY`: the only code that reads or writes `Shop` (III.1). */
@Injectable()
export class SequelizeShopRepository implements ShopRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async insert(input: {
    id: string;
    name: string;
    slug: string;
    region: string;
    now: Date;
    sandboxOf?: string;
  }) {
    const inserted = await this.rows<{ id: string }>(
      `INSERT INTO "Shop" ("id","slug","name","sandboxOf","createdAt","updatedAt") VALUES ($1,$2,$3,$5,$4,$4)
       ON CONFLICT DO NOTHING RETURNING "id"`,
      [input.id, input.slug, input.name, input.now, input.sandboxOf ?? null],
    );
    if (inserted.length === 0) return null;
    return {
      id: input.id,
      slug: input.slug,
      name: input.name,
      plan: 'STARTER' as const,
      planVersion: 0,
      status: 'ACTIVE' as const,
      purgeAt: null,
      shopVersion: 1,
      verificationStatus: 'UNVERIFIED' as const,
      payoutsEnabled: false,
      sandboxOf: input.sandboxOf ?? null,
      region: input.region,
      createdAt: input.now,
    };
  }

  async findById(shopId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${SELECT} FROM ${FROM} WHERE s."id" = $1`,
      [shopId],
    );
    return row ? toRecord(row) : null;
  }

  async findBySlug(slug: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${SELECT} FROM ${FROM} WHERE s."slug" = $1`,
      [slug],
    );
    return row ? toRecord(row) : null;
  }

  async findSandboxOf(liveShopId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${SELECT} FROM ${FROM} WHERE s."sandboxOf" = $1`,
      [liveShopId],
    );
    return row ? toRecord(row) : null;
  }

  async findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.rows<Row>(
      `SELECT ${SELECT} FROM ${FROM} WHERE s."id" = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return rows.map(toRecord);
  }

  async lockById(shopId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${SELECT} FROM ${FROM} WHERE s."id" = $1 FOR UPDATE OF s`,
      [shopId],
    );
    return row ? toRecord(row) : null;
  }

  async patchName(shopId: string, name: string, now: Date) {
    const updated = await this.rows<{ id: string }>(
      `UPDATE "Shop" SET "name" = $2, "shopVersion" = "shopVersion" + 1, "updatedAt" = $3
       WHERE "id" = $1 AND "status" <> 'DELETED' RETURNING "id"`,
      [shopId, name, now],
    );
    return updated.length === 0 ? null : this.findById(shopId);
  }

  async applyPlan(shopId: string, plan: ShopPlan, version: number, now: Date) {
    const updated = await this.rows<{ id: string }>(
      `UPDATE "Shop" SET "plan" = $2, "planVersion" = $3, "shopVersion" = "shopVersion" + 1, "updatedAt" = $4
       WHERE "id" = $1 AND "status" <> 'DELETED' AND "planVersion" < $3 RETURNING "id"`,
      [shopId, plan, version, now],
    );
    return updated.length === 0 ? null : this.findById(shopId);
  }

  async lockOwnerCreation(userId: string) {
    await this.rows(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `shop-owner:${userId}`,
    ]);
  }

  async countOwnedBy(userId: string) {
    const [row] = await this.rows<{ n: string }>(
      `SELECT count(*) AS "n" FROM "ShopMembership" m JOIN "Shop" s ON s."id" = m."shopId"
       WHERE m."userId" = $1 AND m."role" = 'OWNER' AND s."status" <> 'DELETED' AND s."sandboxOf" IS NULL`,
      [userId],
    );
    return Number(row.n);
  }

  async listForUser(
    userId: string,
    after: { key: string; id: string } | null,
    limit: number,
  ): Promise<ShopListRow[]> {
    return this.rows<ShopListRow>(
      `SELECT s."id", s."name", s."slug", s."plan", s."status", m."role", m."createdAt" AS "joinedAt",
              m."createdAt"::text AS "cursorKey"
       FROM "ShopMembership" m JOIN "Shop" s ON s."id" = m."shopId"
       WHERE m."userId" = $1 AND s."sandboxOf" IS NULL AND s."status" <> 'DELETED'
         AND ($2::timestamptz IS NULL OR (m."createdAt", m."shopId") > ($2::timestamptz, $3::uuid))
       ORDER BY m."createdAt", m."shopId" LIMIT $4`,
      [userId, after?.key ?? null, after?.id ?? null, limit],
    );
  }
}
