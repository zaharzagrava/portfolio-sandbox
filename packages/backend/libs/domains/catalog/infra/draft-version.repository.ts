import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  TransactionRunner,
  getActiveTransaction,
} from '@app/infrastructure/context';
import type {
  NewVersion,
  VersionListRow,
  VersionRecord,
  VersionRepository,
} from '../domain/draft-ports';
import type { DraftCursorKey } from '../domain/draft-cursor';

const VERSION_COLUMNS = `v."id", v."draftId", v."shopId", v."name", v."kind", v."objectKey", v."createdBy", v."createdAt"`;

const CREATED_AT_KEY = `to_char(v."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"`;

interface Row {
  id: string;
  draftId: string;
  shopId: string;
  name: string;
  kind: 'named' | 'published';
  objectKey: string;
  createdBy: string;
  createdAt: Date;
  createdAtKey?: string;
}

const toVersionRecord = (row: Row): VersionRecord => ({
  id: row.id,
  draftId: row.draftId,
  shopId: row.shopId,
  name: row.name,
  kind: row.kind,
  objectKey: row.objectKey,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

/** Postgres adapter of `VersionRepository` (S06). The shop is in every predicate (III.4). */
@Injectable()
export class SequelizeVersionRepository implements VersionRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
  ) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  private insertSql(returning: boolean) {
    return `INSERT INTO "ListingDraftVersion" AS v ("id","draftId","shopId","name","kind","objectKey","createdBy","createdAt")
            SELECT $1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::uuid,$8::timestamptz
             ${returning ? '' : 'WHERE true'}`;
  }

  insertWithinCap(
    input: NewVersion,
    cap: number,
  ): Promise<VersionRecord | null> {
    return this.runner.run(async () => {
      await this.rows(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [
        input.draftId,
      ]);
      const [row] = await this.rows<Row>(
        `${this.insertSql(true)}
          WHERE (SELECT count(*) FROM "ListingDraftVersion" WHERE "draftId" = $2::uuid AND "shopId" = $3::uuid) < $9::int
         RETURNING ${VERSION_COLUMNS}`,
        [
          input.id,
          input.draftId,
          input.shopId,
          input.name,
          input.kind,
          input.objectKey,
          input.createdBy,
          input.now,
          cap,
        ],
      );
      return row ? toVersionRecord(row) : null;
    });
  }

  async insertPublished(input: NewVersion): Promise<VersionRecord> {
    const [row] = await this.rows<Row>(
      `${this.insertSql(false)} RETURNING ${VERSION_COLUMNS}`,
      [
        input.id,
        input.draftId,
        input.shopId,
        input.name,
        'published',
        input.objectKey,
        input.createdBy,
        input.now,
      ],
    );
    return toVersionRecord(row);
  }

  async findInDraft(shopId: string, draftId: string, versionId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${VERSION_COLUMNS} FROM "ListingDraftVersion" v
        WHERE v."id" = $1::uuid AND v."draftId" = $2::uuid AND v."shopId" = $3::uuid`,
      [versionId, draftId, shopId],
    );
    return row ? toVersionRecord(row) : null;
  }

  async list(
    shopId: string,
    draftId: string,
    after: DraftCursorKey | null,
    limit: number,
  ): Promise<VersionListRow[]> {
    const bind: unknown[] = [shopId, draftId, limit];
    let where = `v."shopId" = $1::uuid AND v."draftId" = $2::uuid`;
    if (after) {
      bind.push(after.at, after.id);
      where += ` AND (v."createdAt", v."id") < ($${bind.length - 1}::timestamptz, $${bind.length}::uuid)`;
    }
    const rows = await this.rows<Row>(
      `SELECT ${VERSION_COLUMNS}, ${CREATED_AT_KEY} FROM "ListingDraftVersion" v WHERE ${where}
        ORDER BY v."createdAt" DESC, v."id" DESC LIMIT $3::int`,
      bind,
    );
    return rows.map((row) => ({
      record: toVersionRecord(row),
      key: { at: row.createdAtKey!, id: row.id },
    }));
  }

  async referencedKeys(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.rows<{ objectKey: string }>(
      `SELECT "objectKey" FROM "ListingDraftVersion" WHERE "objectKey" = ANY($1::text[])`,
      [keys],
    );
    return new Set(rows.map((r) => r.objectKey));
  }
}
