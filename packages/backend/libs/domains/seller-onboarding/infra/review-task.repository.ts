import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ReviewQueueRow,
  ReviewTaskForResolve,
  ReviewTaskRecord,
  ReviewTaskRepository,
} from '../domain/ports';
import type { DocumentKind } from '../domain/questionnaire';
import { count, json, one, rows } from './sql';

/** `ReviewTask` (own table), joined only with this domain's `ShopDocument`, `DocumentExtraction` and `ShopOnboarding`. */
@Injectable()
export class SequelizeReviewTaskRepository implements ReviewTaskRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async open(input: {
    documentId: string;
    shopId: string;
    reasons: unknown;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "ReviewTask" ("documentId", "shopId", "reasons", "createdAt")
         VALUES (:documentId, :shopId, CAST(:reasons AS jsonb), :now)
         ON CONFLICT ("documentId") WHERE "status" = 'OPEN' DO NOTHING RETURNING 1`,
        { ...input, reasons: json(input.reasons) },
      )) > 0
    );
  }

  async page(input: {
    after: { createdAt: Date; id: string } | null;
    limit: number;
    kind: DocumentKind | null;
  }): Promise<ReviewQueueRow[]> {
    const found = await rows<
      Omit<ReviewQueueRow, 'attempts'> & { attempts: string }
    >(
      this.db,
      `SELECT t."id", t."documentId", t."shopId", t."status", t."reasons", t."createdAt",
              d."kind", d."storageKey", d."purgedAt", e."model", e."fields", COALESCE(e."attempts", 0)::text AS "attempts"
         FROM "ReviewTask" t
         JOIN "ShopDocument" d ON d."id" = t."documentId" AND d."status" = 'NEEDS_REVIEW'
         LEFT JOIN LATERAL (
           SELECT x."model", x."fields", (SELECT count(*) FROM "DocumentExtraction" c WHERE c."documentId" = d."id") AS "attempts"
             FROM "DocumentExtraction" x WHERE x."documentId" = d."id" ORDER BY x."attempt" DESC LIMIT 1) e ON true
        WHERE t."status" = 'OPEN'
          AND (CAST(:kind AS text) IS NULL OR d."kind" = :kind)
          AND (CAST(:afterId AS uuid) IS NULL OR (t."createdAt", t."id") > (CAST(:afterCreatedAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY t."createdAt", t."id"
        LIMIT :limit`,
      {
        kind: input.kind,
        afterId: input.after?.id ?? null,
        afterCreatedAt: input.after?.createdAt ?? null,
        limit: input.limit,
      },
    );
    return found.map((r) => ({ ...r, attempts: Number(r.attempts) }));
  }

  find(taskId: string): Promise<ReviewTaskRecord | null> {
    return one<ReviewTaskRecord>(
      this.db,
      `SELECT "id", "documentId", "shopId", "status", "reasons", "createdAt" FROM "ReviewTask" WHERE "id" = :taskId`,
      { taskId },
    );
  }

  lock(taskId: string): Promise<ReviewTaskForResolve | null> {
    return one<ReviewTaskForResolve>(
      this.db,
      `SELECT t."id", t."documentId", t."shopId", t."status", t."reasons", t."createdAt",
              d."kind", d."status" AS "documentStatus", o."answers"->'business'->>'country' AS "country"
         FROM "ReviewTask" t
         JOIN "ShopDocument" d ON d."id" = t."documentId"
         LEFT JOIN "ShopOnboarding" o ON o."shopId" = t."shopId"
        WHERE t."id" = :taskId FOR UPDATE OF t`,
      { taskId },
    );
  }

  async resolve(input: {
    id: string;
    to: 'APPROVED' | 'REJECTED';
    reviewerId: string;
    corrections: unknown;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ReviewTask" SET "status" = :to, "resolvedBy" = :reviewerId, "resolvedAt" = :now,
                "corrections" = CAST(:corrections AS jsonb)
          WHERE "id" = :id AND "status" = 'OPEN' RETURNING 1`,
        { ...input, corrections: json(input.corrections) },
      )) > 0
    );
  }

  cancelForDocuments(documentIds: string[]): Promise<number> {
    if (documentIds.length === 0) return Promise.resolve(0);
    return count(
      this.db,
      `UPDATE "ReviewTask" SET "status" = 'CANCELLED' WHERE "documentId" IN (:documentIds) AND "status" = 'OPEN' RETURNING 1`,
      { documentIds },
    );
  }

  cancelForShop(shopId: string): Promise<number> {
    return count(
      this.db,
      `UPDATE "ReviewTask" SET "status" = 'CANCELLED' WHERE "shopId" = :shopId AND "status" = 'OPEN' RETURNING 1`,
      { shopId },
    );
  }

  async oldestOpen(): Promise<Date | null> {
    const row = await one<{ at: Date | null }>(
      this.db,
      `SELECT min("createdAt") AS "at" FROM "ReviewTask" WHERE "status" = 'OPEN'`,
    );
    return row?.at ?? null;
  }
}
