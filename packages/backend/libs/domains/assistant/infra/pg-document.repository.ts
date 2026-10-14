import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { TransactionRunner } from '@app/infrastructure/context';
import type { FailureCode } from '../domain/failure-codes';
import type {
  ByteRemoval,
  DocumentListQuery,
  DocumentRecord,
  DocumentRepository,
  InsertResult,
  NewDocument,
} from '../domain/ports';
import type { DocumentScope, Visibility } from '../domain/scope';

const TS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
/** The columns of a `DocumentRecord`; timestamps come back as microsecond text so the cursor compares exactly. */
const COLUMNS = `d.id, d."shopId", d."productId", d.visibility, d.title, d.format, d."storageKey", d."contentHash",
  d."contentSize"::float8 AS "contentSize", d.status, d."failureCode", d."chunkCount", d."indexedHash",
  d."embeddingModel", d."leaseToken",
  to_char(d."createdAt" AT TIME ZONE 'UTC', ${TS}) AS "createdAt",
  to_char(d."updatedAt" AT TIME ZONE 'UTC', ${TS}) AS "updatedAt"`;
const RETURNING = COLUMNS.replace(/\bd\./g, '');
const TOMBSTONE = `status = 'DELETED', "chunkCount" = 0, title = '', "deletedAt" = now(), "queuedAt" = NULL,
  "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = now()`;

type Replacements = Record<string, unknown>;

/** The scope predicate of a document statement: one shop, or the platform (documents without a shop). */
function scopeSql(
  scope: DocumentScope,
  alias = '',
): { sql: string; replacements: Replacements } {
  const col = `${alias}"shopId"`;
  return scope.kind === 'platform'
    ? { sql: `${col} IS NULL`, replacements: {} }
    : {
        sql: `${col} = :scopeShopId`,
        replacements: { scopeShopId: scope.shopId },
      };
}

const seconds = (ms: number) => ms / 1000;

/**
 * Raw SQL over `KnowledgeDocument` (D-6: nothing outside `infra/` issues SQL). Every state change is one conditional
 * `UPDATE … WHERE status = :from [AND "leaseToken" = :t] RETURNING …`; zero rows means the document was not in the
 * expected state. Statements join the active transaction through the CLS shim, so `TransactionRunner.run` composes them.
 */
@Injectable()
export class PgDocumentRepository implements DocumentRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
  ) {}

  private select(sql: string, replacements: Replacements = {}) {
    return this.sequelize.query<DocumentRecord>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  /** Runs a data-changing statement and reports how many rows it changed. */
  private async exec(sql: string, replacements: Replacements): Promise<number> {
    const [, meta] = await this.sequelize.query(sql, { replacements });
    return (meta as { rowCount?: number } | undefined)?.rowCount ?? 0;
  }

  async findByHash(
    scope: DocumentScope,
    productId: string | null,
    visibility: Visibility,
    contentHash: string,
  ): Promise<DocumentRecord | null> {
    const s = scopeSql(scope, 'd.');
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "KnowledgeDocument" d
        WHERE ${s.sql} AND d."productId" IS NOT DISTINCT FROM CAST(:productId AS uuid)
          AND d.visibility = :visibility AND d."contentHash" = :hash AND d.status <> 'DELETED'`,
      { ...s.replacements, productId, visibility, hash: contentHash },
    );
    return row ?? null;
  }

  async insert(doc: NewDocument, cap: number | null): Promise<InsertResult> {
    const shopId = doc.scope.kind === 'shop' ? doc.scope.shopId : null;
    const rows = await this.select(
      `INSERT INTO "KnowledgeDocument"
         (id, "shopId", "productId", visibility, title, format, "storageKey", "contentHash", "contentSize", status, "queuedAt", "createdBy")
       SELECT CAST(:id AS uuid), CAST(:shopId AS uuid), CAST(:productId AS uuid), :visibility, :title, :format, :storageKey,
              :hash, :size, :status, CASE WHEN CAST(:status AS text) = 'QUEUED' THEN now() END, CAST(:createdBy AS uuid)
        WHERE CAST(:cap AS integer) IS NULL
           OR (SELECT count(*) FROM "KnowledgeDocument" WHERE "shopId" = CAST(:shopId AS uuid) AND status <> 'DELETED') < CAST(:cap AS integer)
       ON CONFLICT DO NOTHING
       RETURNING ${RETURNING}`,
      {
        id: doc.id,
        shopId,
        productId: doc.productId,
        visibility: doc.visibility,
        title: doc.title,
        format: doc.format,
        storageKey: doc.storageKey,
        hash: doc.contentHash,
        size: doc.contentSize,
        status: doc.status,
        createdBy: doc.createdBy,
        cap,
      },
    );
    if (rows[0]) return { kind: 'created', document: rows[0] };
    // Zero rows: the bytes already exist in this scope (a concurrent create won), or the shop is at its cap.
    const existing = await this.findByHash(
      doc.scope,
      doc.productId,
      doc.visibility,
      doc.contentHash,
    );
    return existing
      ? { kind: 'existing', document: existing }
      : { kind: 'cap_reached' };
  }

  async find(scope: DocumentScope, id: string): Promise<DocumentRecord | null> {
    const s = scopeSql(scope, 'd.');
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "KnowledgeDocument" d WHERE d.id = :id AND ${s.sql} AND d.status <> 'DELETED'`,
      { ...s.replacements, id },
    );
    return row ?? null;
  }

  async queue(
    scope: DocumentScope,
    id: string,
    from: 'AWAITING_UPLOAD' | 'FAILED',
  ): Promise<DocumentRecord | null> {
    const s = scopeSql(scope);
    const [row] = await this.select(
      `UPDATE "KnowledgeDocument" SET status = 'QUEUED', "failureCode" = NULL, "queuedAt" = now(), "updatedAt" = now()
        WHERE id = :id AND ${s.sql} AND status = :from RETURNING ${RETURNING}`,
      { ...s.replacements, id, from },
    );
    return row ?? null;
  }

  async list(
    scope: DocumentScope,
    query: DocumentListQuery,
  ): Promise<{ items: DocumentRecord[]; hasMore: boolean }> {
    const s = scopeSql(scope, 'd.');
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "KnowledgeDocument" d
        WHERE ${s.sql} AND d.status <> 'DELETED'
          ${query.status ? 'AND d.status = :status' : ''}
          ${query.after ? 'AND (d."createdAt", d.id) < (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid))' : ''}
        ORDER BY d."createdAt" DESC, d.id DESC LIMIT :limit`,
      {
        ...s.replacements,
        status: query.status,
        afterAt: query.after?.createdAt,
        afterId: query.after?.id,
        limit: query.limit + 1,
      },
    );
    return {
      items: rows.slice(0, query.limit),
      hasMore: rows.length > query.limit,
    };
  }

  async remove(scope: DocumentScope, id: string): Promise<ByteRemoval | null> {
    const s = scopeSql(scope);
    return this.tx.run(async () => {
      const [row] = await this.sequelize.query<ByteRemoval>(
        `UPDATE "KnowledgeDocument" SET ${TOMBSTONE}
          WHERE id = :id AND ${s.sql} AND status <> 'DELETED' RETURNING id, "storageKey"`,
        { type: QueryTypes.SELECT, replacements: { ...s.replacements, id } },
      );
      if (!row) return null;
      await this.sequelize.query(
        `DELETE FROM "KnowledgeChunk" WHERE "documentId" = :id`,
        { replacements: { id } },
      );
      return row;
    });
  }

  async claim(id: string, leaseMs: number): Promise<DocumentRecord | null> {
    const [row] = await this.select(
      `UPDATE "KnowledgeDocument"
          SET status = 'PROCESSING', "leaseToken" = CAST(:token AS uuid),
              "leaseUntil" = now() + make_interval(secs => CAST(:secs AS double precision)), "updatedAt" = now()
        WHERE id = :id AND (status = 'QUEUED' OR (status = 'PROCESSING' AND "leaseUntil" < now()))
        RETURNING ${RETURNING}`,
      { id, token: uuidv7(), secs: seconds(leaseMs) },
    );
    return row ?? null;
  }

  async fail(
    id: string,
    leaseToken: string,
    code: FailureCode,
  ): Promise<boolean> {
    return (
      (await this.exec(
        `UPDATE "KnowledgeDocument"
            SET status = 'FAILED', "failureCode" = :code, "leaseToken" = NULL, "leaseUntil" = NULL, "queuedAt" = NULL, "updatedAt" = now()
          WHERE id = :id AND "leaseToken" = CAST(:token AS uuid) AND status = 'PROCESSING'`,
        { id, token: leaseToken, code },
      )) > 0
    );
  }

  async release(id: string, leaseToken: string): Promise<boolean> {
    return (
      (await this.exec(
        `UPDATE "KnowledgeDocument"
            SET status = 'QUEUED', "leaseToken" = NULL, "leaseUntil" = NULL, "queuedAt" = now(), "updatedAt" = now()
          WHERE id = :id AND "leaseToken" = CAST(:token AS uuid) AND status = 'PROCESSING'`,
        { id, token: leaseToken },
      )) > 0
    );
  }

  async markReady(
    id: string,
    leaseToken: string,
    indexed: {
      chunkCount: number;
      indexedHash: string;
      embeddingModel: string;
    },
  ): Promise<boolean> {
    return (
      (await this.exec(
        `UPDATE "KnowledgeDocument"
            SET status = 'READY', "chunkCount" = :n, "indexedHash" = :hash, "embeddingModel" = :model, "failureCode" = NULL,
                "leaseToken" = NULL, "leaseUntil" = NULL, "queuedAt" = NULL, "updatedAt" = now()
          WHERE id = :id AND "leaseToken" = CAST(:token AS uuid) AND status = 'PROCESSING'`,
        {
          id,
          token: leaseToken,
          n: indexed.chunkCount,
          hash: indexed.indexedHash,
          model: indexed.embeddingModel,
        },
      )) > 0
    );
  }

  async expireAbandonedUploads(
    olderThanMs: number,
    limit: number,
  ): Promise<ByteRemoval[]> {
    return this.sequelize.query<ByteRemoval>(
      `UPDATE "KnowledgeDocument" SET ${TOMBSTONE}
        WHERE id IN (SELECT id FROM "KnowledgeDocument"
                      WHERE status = 'AWAITING_UPLOAD' AND "createdAt" < now() - make_interval(secs => CAST(:secs AS double precision))
                      ORDER BY "createdAt" LIMIT :limit FOR UPDATE SKIP LOCKED)
          AND status = 'AWAITING_UPLOAD'
        RETURNING id, "storageKey"`,
      {
        type: QueryTypes.SELECT,
        replacements: { secs: seconds(olderThanMs), limit },
      },
    );
  }

  async requeueStale(olderThanMs: number, limit: number): Promise<string[]> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE "KnowledgeDocument" SET "queuedAt" = now(), "updatedAt" = now()
        WHERE id IN (SELECT id FROM "KnowledgeDocument"
                      WHERE status = 'QUEUED' AND "queuedAt" < now() - make_interval(secs => CAST(:secs AS double precision))
                      ORDER BY "queuedAt" LIMIT :limit FOR UPDATE SKIP LOCKED)
          AND status = 'QUEUED'
        RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { secs: seconds(olderThanMs), limit },
      },
    );
    return rows.map((r) => r.id);
  }

  async releaseExpiredLeases(limit: number): Promise<string[]> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE "KnowledgeDocument"
          SET status = 'QUEUED', "leaseToken" = NULL, "leaseUntil" = NULL, "queuedAt" = now(), "updatedAt" = now()
        WHERE id IN (SELECT id FROM "KnowledgeDocument"
                      WHERE status = 'PROCESSING' AND "leaseUntil" < now() ORDER BY "leaseUntil" LIMIT :limit FOR UPDATE SKIP LOCKED)
          AND status = 'PROCESSING' AND "leaseUntil" < now()
        RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    );
    return rows.map((r) => r.id);
  }

  pendingByteRemovals(limit: number): Promise<ByteRemoval[]> {
    return this.sequelize.query<ByteRemoval>(
      `SELECT id, "storageKey" FROM "KnowledgeDocument"
        WHERE status = 'DELETED' AND "bytesRemovedAt" IS NULL AND "storageKey" <> '' ORDER BY "deletedAt" LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { limit } },
    );
  }

  async markBytesRemoved(id: string): Promise<void> {
    await this.exec(
      `UPDATE "KnowledgeDocument" SET "bytesRemovedAt" = now() WHERE id = :id AND status = 'DELETED' AND "bytesRemovedAt" IS NULL`,
      { id },
    );
  }

  purgeTombstones(olderThanDays: number, limit: number): Promise<number> {
    return this.exec(
      `DELETE FROM "KnowledgeDocument"
        WHERE id IN (SELECT id FROM "KnowledgeDocument"
                      WHERE status = 'DELETED' AND "bytesRemovedAt" IS NOT NULL
                        AND "deletedAt" < now() - make_interval(days => CAST(:days AS integer)) LIMIT :limit)
          AND status = 'DELETED'`,
      { days: olderThanDays, limit },
    );
  }

  async queueStaleModel(model: string, limit: number): Promise<string[]> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE "KnowledgeDocument" SET status = 'QUEUED', "queuedAt" = now(), "updatedAt" = now()
        WHERE id IN (SELECT id FROM "KnowledgeDocument"
                      WHERE status = 'READY' AND "embeddingModel" IS DISTINCT FROM :model ORDER BY id LIMIT :limit FOR UPDATE SKIP LOCKED)
          AND status = 'READY'
        RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { model, limit } },
    );
    return rows.map((r) => r.id);
  }

  async purgeBatch(
    by: { productId: string } | { shopId: string },
    limit: number,
  ): Promise<ByteRemoval[]> {
    const column = 'productId' in by ? '"productId"' : '"shopId"';
    const value = 'productId' in by ? by.productId : by.shopId;
    // Plain FOR UPDATE (no SKIP LOCKED): a document being committed is waited for, so it ends DELETED with no passages.
    return this.tx.run(async () => {
      const removed = await this.sequelize.query<ByteRemoval>(
        `UPDATE "KnowledgeDocument" SET ${TOMBSTONE}
          WHERE id IN (SELECT id FROM "KnowledgeDocument" WHERE ${column} = CAST(:value AS uuid) AND status <> 'DELETED'
                        ORDER BY id LIMIT :limit FOR UPDATE)
          RETURNING id, "storageKey"`,
        { type: QueryTypes.SELECT, replacements: { value, limit } },
      );
      if (removed.length)
        await this.sequelize.query(
          `DELETE FROM "KnowledgeChunk" WHERE "documentId" IN (:ids)`,
          { replacements: { ids: removed.map((r) => r.id) } },
        );
      return removed;
    });
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.sequelize.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM "KnowledgeDocument" GROUP BY status`,
      { type: QueryTypes.SELECT },
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
