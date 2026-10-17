import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, UniqueConstraintError, type Sequelize } from 'sequelize';
import { decodeFunctionCursor, encodeFunctionCursor } from '../domain/cursor';
import { functionLimitReached, functionNameTaken } from '../domain/errors';
import type {
  ActiveFunction,
  FunctionRecord,
  FunctionRepository,
  FunctionView,
  KeysetPage,
} from '../domain/ports';

interface FunctionRow {
  id: string;
  shopId: string;
  name: string;
  enabled: boolean;
  activeVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}
interface ViewRow extends FunctionRow {
  testCount: number;
  latestVersion: number | null;
  cursorAt: string;
}

const COLUMNS = `f."id", f."shopId", f."name", f."enabled", f."activeVersion", f."createdAt", f."updatedAt"`;
const VIEW = `SELECT ${COLUMNS}, f."createdAt"::text AS "cursorAt",
  (SELECT COUNT(*)::int FROM "ShopFunctionTestCase" c WHERE c."functionId" = f."id" AND c."version" IS NULL) AS "testCount",
  (SELECT MAX(v."version") FROM "ShopFunctionVersion" v WHERE v."functionId" = f."id") AS "latestVersion"
  FROM "ShopFunction" f`;

const toRecord = (row: FunctionRow): FunctionRecord => ({
  id: row.id,
  shopId: row.shopId,
  name: row.name,
  enabled: row.enabled,
  activeVersion: row.activeVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const toView = (row: ViewRow): FunctionView => ({
  ...toRecord(row),
  testCount: row.testCount,
  latestVersion: row.latestVersion,
});

/** `ShopFunction` rows. Every lookup carries the shop in its predicate (constitution III.4); queries join the caller's transaction through CLS. */
@Injectable()
export class PgFunctionRepository implements FunctionRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async create(shopId: string, name: string, maxFunctions: number) {
    // One writer per shop at a time: the count below cannot be a constraint.
    await this.sequelize.query(
      `SELECT pg_advisory_xact_lock(hashtext('shopfn:' || :shopId))`,
      { replacements: { shopId } },
    );
    const [taken] = await this.select<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "ShopFunction" WHERE "shopId" = :shopId AND lower("name") = lower(:name)`,
      { shopId, name },
    );
    if (taken.n > 0) throw functionNameTaken();
    const [count] = await this.select<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "ShopFunction" WHERE "shopId" = :shopId`,
      { shopId },
    );
    if (count.n >= maxFunctions) throw functionLimitReached(maxFunctions);
    try {
      const [row] = await this.select<FunctionRow>(
        `INSERT INTO "ShopFunction" ("shopId", "name") VALUES (:shopId, :name)
         RETURNING "id", "shopId", "name", "enabled", "activeVersion", "createdAt", "updatedAt"`,
        { shopId, name },
      );
      return toRecord(row);
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw functionNameTaken();
      throw error;
    }
  }

  async list(
    shopId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<FunctionView>> {
    const after = cursor ? decodeFunctionCursor(cursor) : null;
    const rows = await this.select<ViewRow>(
      `${VIEW} WHERE f."shopId" = :shopId
         ${after ? `AND (f."createdAt", f."id") < (CAST(:cursorAt AS timestamptz), CAST(:cursorId AS uuid))` : ''}
       ORDER BY f."createdAt" DESC, f."id" DESC LIMIT :limit`,
      {
        shopId,
        limit: limit + 1,
        cursorAt: after?.createdAt ?? null,
        cursorId: after?.id ?? null,
      },
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toView),
      nextCursor:
        rows.length > limit && last
          ? encodeFunctionCursor({ createdAt: last.cursorAt, id: last.id })
          : null,
    };
  }

  async find(shopId: string, functionId: string) {
    const [row] = await this.select<ViewRow>(
      `${VIEW} WHERE f."shopId" = :shopId AND f."id" = :functionId`,
      { shopId, functionId },
    );
    return row ? toView(row) : null;
  }

  async lock(shopId: string, functionId: string) {
    const [row] = await this.select<FunctionRow>(
      `SELECT ${COLUMNS} FROM "ShopFunction" f WHERE f."shopId" = :shopId AND f."id" = :functionId FOR UPDATE`,
      { shopId, functionId },
    );
    return row ? toRecord(row) : null;
  }

  async delete(shopId: string, functionId: string) {
    const rows = await this.select<{ id: string }>(
      `DELETE FROM "ShopFunction" WHERE "shopId" = :shopId AND "id" = :functionId RETURNING "id"`,
      { shopId, functionId },
    );
    return rows.length === 1;
  }

  async setEnabled(shopId: string, functionId: string, enabled: boolean) {
    const changed = await this.select<{ id: string }>(
      `UPDATE "ShopFunction" SET "enabled" = :enabled, "updatedAt" = now()
       WHERE "shopId" = :shopId AND "id" = :functionId AND "enabled" <> :enabled RETURNING "id"`,
      { shopId, functionId, enabled },
    );
    if (changed.length === 1) return true;
    const [exists] = await this.select<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "shopId" = :shopId AND "id" = :functionId`,
      { shopId, functionId },
    );
    return exists ? false : null;
  }

  activeFor(shopIds: string[]): Promise<ActiveFunction[]> {
    if (shopIds.length === 0) return Promise.resolve([]);
    return this.select<ActiveFunction>(
      `SELECT f."id", f."shopId", f."name", v."version", v."source", v."sourceHash"
       FROM "ShopFunction" f
       JOIN "ShopFunctionVersion" v ON v."functionId" = f."id" AND v."version" = f."activeVersion" AND v."status" = 'ACTIVE'
       WHERE f."shopId" IN (:shopIds) AND f."enabled"
       ORDER BY f."shopId", f."name" COLLATE "C", f."id"`,
      { shopIds },
    );
  }
}
