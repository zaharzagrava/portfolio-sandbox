import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  TransactionRunner,
  getActiveTransaction,
} from '@app/infrastructure/context';
import type {
  DraftListRow,
  DraftRecord,
  DraftRepository,
  DraftTransition,
  NewDraft,
} from '../domain/draft-ports';
import type { DraftCursorKey } from '../domain/draft-cursor';
import type { DraftStatus } from '../domain/draft-status';

export const DRAFT_COLUMNS = `d."id", d."shopId", d."productId", d."baseProductVersion", d."title", d."status", d."createdBy",
  d."publishLeaseId", d."publishLeaseExpiresAt", d."publishedAt", d."snapshotKey", d."snapshotSeq", d."createdAt", d."updatedAt"`;

const UPDATED_AT_KEY = `to_char(d."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtKey"`;

interface Row {
  id: string;
  shopId: string;
  productId: string | null;
  baseProductVersion: number | null;
  title: string;
  status: DraftStatus;
  createdBy: string;
  publishLeaseId: string | null;
  publishLeaseExpiresAt: Date | null;
  publishedAt: Date | null;
  snapshotKey: string | null;
  snapshotSeq: string;
  createdAt: Date;
  updatedAt: Date;
  updatedAtKey?: string;
}

export const toDraftRecord = (row: Row): DraftRecord => ({
  id: row.id,
  shopId: row.shopId,
  productId: row.productId,
  baseProductVersion: row.baseProductVersion,
  title: row.title,
  status: row.status,
  createdBy: row.createdBy,
  publishLeaseId: row.publishLeaseId,
  publishLeaseExpiresAt: row.publishLeaseExpiresAt,
  publishedAt: row.publishedAt,
  snapshotKey: row.snapshotKey,
  snapshotSeq: Number(row.snapshotSeq),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Postgres adapter of `DraftRepository` (S06): the only code that reads or writes `ListingDraft` and, with the version
 * repository, `ListingDraftVersion`. Parameterised SQL; every statement carries the shop in its predicate (III.4);
 * every transition is a conditional update whose row count the caller asserts (III.7).
 */
@Injectable()
export class SequelizeDraftRepository implements DraftRepository {
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

  insertWithinCap(input: NewDraft, cap: number): Promise<DraftRecord | null> {
    // The advisory lock serialises creates of one shop; the count is taken by the next statement, which sees every
    // draft committed while this one waited (READ COMMITTED takes a new snapshot per statement).
    return this.runner.run(async () => {
      await this.rows(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [
        input.shopId,
      ]);
      const [row] = await this.rows<Row>(
        `INSERT INTO "ListingDraft" AS d ("id","shopId","productId","baseProductVersion","title","status","createdBy","snapshotSeq","createdAt","updatedAt")
         SELECT $1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,'DRAFT',$6::uuid,0,$7::timestamptz,$7::timestamptz
          WHERE (SELECT count(*) FROM "ListingDraft" WHERE "shopId" = $2::uuid AND "status" IN ('DRAFT','PUBLISHING')) < $8::int
         RETURNING ${DRAFT_COLUMNS}`,
        [
          input.id,
          input.shopId,
          input.productId,
          input.baseProductVersion,
          input.title,
          input.createdBy,
          input.now,
          cap,
        ],
      );
      return row ? toDraftRecord(row) : null;
    });
  }

  async findInShop(shopId: string, draftId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${DRAFT_COLUMNS} FROM "ListingDraft" d WHERE d."id" = $1::uuid AND d."shopId" = $2::uuid`,
      [draftId, shopId],
    );
    return row ? toDraftRecord(row) : null;
  }

  async listByShop(
    shopId: string,
    status: DraftStatus | null,
    after: DraftCursorKey | null,
    limit: number,
  ): Promise<DraftListRow[]> {
    const bind: unknown[] = [shopId, limit];
    let where = `d."shopId" = $1::uuid`;
    if (status) {
      bind.push(status);
      where += ` AND d."status" = $${bind.length}::text`;
    }
    if (after) {
      bind.push(after.at, after.id);
      where += ` AND (d."updatedAt", d."id") < ($${bind.length - 1}::timestamptz, $${bind.length}::uuid)`;
    }
    const rows = await this.rows<Row>(
      `SELECT ${DRAFT_COLUMNS}, ${UPDATED_AT_KEY} FROM "ListingDraft" d WHERE ${where}
        ORDER BY d."updatedAt" DESC, d."id" DESC LIMIT $2::int`,
      bind,
    );
    return rows.map((row) => ({
      record: toDraftRecord(row),
      key: { at: row.updatedAtKey!, id: row.id },
    }));
  }

  async transition(change: DraftTransition): Promise<DraftRecord | null> {
    const claiming = change.to === 'PUBLISHING';
    const [row] = await this.rows<Row>(
      `UPDATE "ListingDraft" AS d SET
         "status" = $4::text,
         "updatedAt" = $7::timestamptz,
         "publishLeaseId" = CASE WHEN $4::text = 'PUBLISHING' THEN $5::uuid ELSE NULL END,
         "publishLeaseExpiresAt" = CASE WHEN $4::text = 'PUBLISHING' THEN $6::timestamptz ELSE NULL END,
         "productId" = COALESCE($8::uuid, d."productId"),
         "publishedAt" = CASE WHEN $4::text = 'PUBLISHED' THEN $7::timestamptz ELSE d."publishedAt" END
       WHERE d."id" = $1::uuid AND d."shopId" = $2::uuid AND d."status" = $3::text
         AND ($3::text <> 'PUBLISHING' OR d."publishLeaseId" = $9::uuid)
       RETURNING ${DRAFT_COLUMNS}`,
      [
        change.draftId,
        change.shopId,
        change.from,
        change.to,
        claiming ? (change.leaseId ?? null) : null,
        claiming ? (change.leaseExpiresAt ?? null) : null,
        change.now,
        change.productId ?? null,
        claiming ? null : (change.leaseId ?? null),
      ],
    );
    return row ? toDraftRecord(row) : null;
  }

  async expiredLeases(now: Date, limit: number) {
    return this.rows<{ id: string; shopId: string; leaseId: string }>(
      `SELECT d."id", d."shopId", d."publishLeaseId" AS "leaseId" FROM "ListingDraft" d
        WHERE d."status" = 'PUBLISHING' AND d."publishLeaseExpiresAt" < $1::timestamptz
        ORDER BY d."publishLeaseExpiresAt" LIMIT $2::int`,
      [now, limit],
    );
  }

  async moveSnapshotPointer(
    shopId: string,
    draftId: string,
    key: string,
    seq: number,
  ): Promise<{ moved: boolean; previousKey: string | null }> {
    const [moved] = await this.rows<{ previousKey: string | null }>(
      `WITH old AS (
         SELECT "id", "snapshotKey" FROM "ListingDraft"
          WHERE "id" = $1::uuid AND "shopId" = $2::uuid AND "snapshotSeq" < $4::bigint FOR UPDATE
       ), moved AS (
         UPDATE "ListingDraft" d SET "snapshotKey" = $3::text, "snapshotSeq" = $4::bigint, "updatedAt" = now()
           FROM old WHERE d."id" = old."id" RETURNING old."snapshotKey" AS "previousKey"
       ) SELECT "previousKey" FROM moved`,
      [draftId, shopId, key, seq],
    );
    return moved
      ? { moved: true, previousKey: moved.previousKey }
      : { moved: false, previousKey: null };
  }

  async setSeedPointer(shopId: string, draftId: string, key: string) {
    await this.rows(
      `UPDATE "ListingDraft" SET "snapshotKey" = $3::text
        WHERE "id" = $1::uuid AND "shopId" = $2::uuid AND "snapshotSeq" = 0 AND "snapshotKey" IS NULL
        RETURNING "id"`,
      [draftId, shopId, key],
    );
  }

  async idsOfShop(shopId: string, limit: number): Promise<string[]> {
    const rows = await this.rows<{ id: string }>(
      `SELECT "id" FROM "ListingDraft" WHERE "shopId" = $1::uuid ORDER BY "id" LIMIT $2::int`,
      [shopId, limit],
    );
    return rows.map((r) => r.id);
  }

  async deleteByIds(shopId: string, draftIds: string[]): Promise<number> {
    if (draftIds.length === 0) return 0;
    return this.runner.run(async () => {
      await this.rows(
        `DELETE FROM "ListingDraftVersion" WHERE "shopId" = $1::uuid AND "draftId" = ANY($2::uuid[]) RETURNING "id"`,
        [shopId, draftIds],
      );
      const deleted = await this.rows<{ id: string }>(
        `DELETE FROM "ListingDraft" WHERE "shopId" = $1::uuid AND "id" = ANY($2::uuid[]) RETURNING "id"`,
        [shopId, draftIds],
      );
      return deleted.length;
    });
  }

  async versionKeysOf(shopId: string, draftIds: string[]): Promise<string[]> {
    if (draftIds.length === 0) return [];
    const rows = await this.rows<{ objectKey: string }>(
      `SELECT "objectKey" FROM "ListingDraftVersion" WHERE "shopId" = $1::uuid AND "draftId" = ANY($2::uuid[])`,
      [shopId, draftIds],
    );
    return rows.map((r) => r.objectKey);
  }
}
