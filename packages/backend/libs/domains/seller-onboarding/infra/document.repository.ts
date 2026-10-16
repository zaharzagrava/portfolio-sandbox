import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ClaimedDocument,
  DocumentRecord,
  DocumentRepository,
  DocumentView,
  SupersededDocument,
} from '../domain/ports';
import type { DocumentKind } from '../domain/questionnaire';
import type { DocumentStatus } from '../domain/document-status';
import { count, one, rows } from './sql';

const COLUMNS = `"id", "shopId", "submissionNo", "kind", "contentType", "contentHash", "size", "storageKey", "status", "rejectionReason", "leaseUntil", "purgedAt"`;

/** `ShopDocument` (own table). The seller's listing selects only the four public columns (A39). */
@Injectable()
export class SequelizeDocumentRepository implements DocumentRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  insertAwaiting(input: {
    id: string;
    shopId: string;
    submissionNo: number;
    kind: DocumentKind;
    contentType: string;
    contentHash: string;
    size: number;
    storageKey: string;
    now: Date;
  }): Promise<DocumentRecord | null> {
    return one<DocumentRecord>(
      this.db,
      `INSERT INTO "ShopDocument" ("id", "shopId", "submissionNo", "kind", "contentType", "contentHash", "size", "storageKey", "createdAt", "updatedAt")
       VALUES (:id, :shopId, :submissionNo, :kind, :contentType, :contentHash, :size, :storageKey, :now, :now)
       ON CONFLICT ("shopId", "submissionNo", "kind", "contentHash") DO NOTHING RETURNING ${COLUMNS}`,
      input,
    );
  }

  findByHash(
    shopId: string,
    submissionNo: number,
    kind: DocumentKind,
    contentHash: string,
  ): Promise<DocumentRecord | null> {
    return one<DocumentRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "ShopDocument"
        WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "kind" = :kind AND "contentHash" = :contentHash`,
      { shopId, submissionNo, kind, contentHash },
    );
  }

  find(shopId: string, documentId: string): Promise<DocumentRecord | null> {
    return one<DocumentRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "ShopDocument" WHERE "id" = :documentId AND "shopId" = :shopId`,
      { documentId, shopId },
    );
  }

  findById(documentId: string): Promise<DocumentRecord | null> {
    return one<DocumentRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "ShopDocument" WHERE "id" = :documentId`,
      { documentId },
    );
  }

  listVisible(shopId: string, submissionNo: number): Promise<DocumentView[]> {
    return rows<DocumentView>(
      this.db,
      `SELECT "id", "kind", "status", "rejectionReason" FROM "ShopDocument"
        WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "status" <> 'SUPERSEDED'
        ORDER BY "createdAt" DESC, "id" DESC`,
      { shopId, submissionNo },
    );
  }

  async countOfKind(
    shopId: string,
    submissionNo: number,
    kind: DocumentKind,
  ): Promise<number> {
    const row = await one<{ n: string }>(
      this.db,
      `SELECT count(*)::text AS n FROM "ShopDocument"
        WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "kind" = :kind`,
      { shopId, submissionNo, kind },
    );
    return Number(row?.n ?? 0);
  }

  async approvedKinds(
    shopId: string,
    submissionNo: number,
  ): Promise<DocumentKind[]> {
    const found = await rows<{ kind: DocumentKind }>(
      this.db,
      `SELECT DISTINCT "kind" FROM "ShopDocument"
        WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "status" = 'APPROVED'`,
      { shopId, submissionNo },
    );
    return found.map((r) => r.kind);
  }

  async transition(input: {
    id: string;
    from: DocumentStatus | DocumentStatus[];
    to: DocumentStatus;
    now: Date;
    rejectionReason?: string;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ShopDocument"
            SET "status" = :to, "updatedAt" = :now, "leaseUntil" = NULL,
                "rejectionReason" = COALESCE(:rejectionReason, "rejectionReason")
          WHERE "id" = :id AND "status" IN (:from) RETURNING 1`,
        {
          id: input.id,
          to: input.to,
          now: input.now,
          from: Array.isArray(input.from) ? input.from : [input.from],
          rejectionReason: input.rejectionReason ?? null,
        },
      )) > 0
    );
  }

  claim(input: {
    id: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ClaimedDocument | null> {
    return one<ClaimedDocument>(
      this.db,
      `WITH old AS (
         SELECT "id", "status" FROM "ShopDocument"
          WHERE "id" = :id AND ("status" = 'QUEUED' OR ("status" = 'EXTRACTING' AND "leaseUntil" <= :now)) FOR UPDATE)
       UPDATE "ShopDocument" d SET "status" = 'EXTRACTING', "leaseUntil" = :leaseUntil, "updatedAt" = :now
         FROM old WHERE d."id" = old."id"
       RETURNING ${COLUMNS.split(', ')
         .map((c) => `d.${c}`)
         .join(', ')}, old."status" AS "previousStatus"`,
      input,
    );
  }

  async releaseLease(id: string, now: Date): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ShopDocument" SET "leaseUntil" = :now, "updatedAt" = :now
          WHERE "id" = :id AND "status" = 'EXTRACTING' RETURNING 1`,
        { id, now },
      )) > 0
    );
  }

  async finish(input: {
    id: string;
    to: 'APPROVED' | 'NEEDS_REVIEW';
    now: Date;
  }): Promise<boolean> {
    return this.transition({
      id: input.id,
      from: 'EXTRACTING',
      to: input.to,
      now: input.now,
    });
  }

  supersedeSiblings(input: {
    shopId: string;
    submissionNo: number;
    kind: DocumentKind;
    keepId: string;
    now: Date;
  }): Promise<SupersededDocument[]> {
    return rows<SupersededDocument>(
      this.db,
      `WITH old AS (
         SELECT "id", "status" FROM "ShopDocument"
          WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "kind" = :kind AND "id" <> :keepId
            AND "status" IN ('QUEUED', 'EXTRACTING', 'NEEDS_REVIEW', 'REJECTED') FOR UPDATE)
       UPDATE "ShopDocument" d SET "status" = 'SUPERSEDED', "leaseUntil" = NULL, "updatedAt" = :now
         FROM old WHERE d."id" = old."id" RETURNING d."id", old."status" AS "fromStatus"`,
      input,
    );
  }

  supersedeRound(input: {
    shopId: string;
    submissionNo: number;
    now: Date;
  }): Promise<SupersededDocument[]> {
    return rows<SupersededDocument>(
      this.db,
      `WITH old AS (
         SELECT "id", "status" FROM "ShopDocument"
          WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "status" <> 'SUPERSEDED' FOR UPDATE)
       UPDATE "ShopDocument" d SET "status" = 'SUPERSEDED', "leaseUntil" = NULL, "updatedAt" = :now
         FROM old WHERE d."id" = old."id" RETURNING d."id", old."status" AS "fromStatus"`,
      input,
    );
  }

  listUnpurged(input: {
    shopId: string;
    submissionNo?: number;
  }): Promise<Array<{ id: string; storageKey: string }>> {
    return rows<{ id: string; storageKey: string }>(
      this.db,
      input.submissionNo === undefined
        ? `SELECT "id", "storageKey" FROM "ShopDocument" WHERE "shopId" = :shopId AND "purgedAt" IS NULL ORDER BY "id"`
        : `SELECT "id", "storageKey" FROM "ShopDocument"
            WHERE "shopId" = :shopId AND "submissionNo" = :submissionNo AND "purgedAt" IS NULL
              AND "status" IN ('APPROVED', 'REJECTED', 'SUPERSEDED') ORDER BY "id"`,
      input as Record<string, unknown>,
    );
  }

  async markPurged(id: string, at: Date): Promise<void> {
    await count(
      this.db,
      `UPDATE "ShopDocument" SET "purgedAt" = :at WHERE "id" = :id AND "purgedAt" IS NULL RETURNING 1`,
      { id, at },
    );
  }

  async erase(shopId: string): Promise<void> {
    await count(
      this.db,
      `WITH gone AS (SELECT "id" FROM "ShopDocument" WHERE "shopId" = :shopId),
            a AS (DELETE FROM "DocumentExtraction" WHERE "documentId" IN (SELECT "id" FROM gone) RETURNING 1),
            t AS (DELETE FROM "ReviewTask" WHERE "documentId" IN (SELECT "id" FROM gone) RETURNING 1)
       DELETE FROM "ShopDocument" WHERE "id" IN (SELECT "id" FROM gone) RETURNING 1`,
      { shopId },
    );
  }
}
