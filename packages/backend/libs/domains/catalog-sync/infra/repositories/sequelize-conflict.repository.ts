import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import type {
  ConflictKind,
  ConflictRecord,
  ConflictRepository,
  ConflictStatus,
  OpenConflictInput,
  ListPage,
  PageQuery,
} from '../../domain/ports';
import { KeysetCursorCodec, keysetPage } from './keyset-cursor';
import { count, one, toDate, toDateRequired, toNumberOrNull } from './sql';

const COLUMNS = `"id", "integrationId", "shopId", "externalId", "productId", "kind", "base", "local", "remote", "merged",
  "resolvedTo", "status", "createdAt", "dismissedBy", "dismissedAt", "resolution"`;

function toConflict(r: Record<string, unknown>): ConflictRecord {
  return {
    id: r.id as string,
    integrationId: r.integrationId as string,
    shopId: r.shopId as string,
    externalId: r.externalId as string,
    productId: (r.productId ?? null) as string | null,
    kind: r.kind as ConflictKind,
    base: Number(r.base),
    local: Number(r.local),
    remote: Number(r.remote),
    merged: toNumberOrNull(r.merged),
    resolvedTo: toNumberOrNull(r.resolvedTo),
    status: r.status as ConflictStatus,
    createdAt: toDateRequired(r.createdAt),
    dismissedBy: (r.dismissedBy ?? null) as string | null,
    dismissedAt: toDate(r.dismissedAt),
    resolution: (r.resolution ?? null) as string | null,
  };
}

/** `StockConflict` (own table). */
@Injectable()
export class SequelizeConflictRepository implements ConflictRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  async open(
    i: OpenConflictInput,
    now: Date,
  ): Promise<{ conflict: ConflictRecord; created: boolean }> {
    const replacements = { ...i, now };
    const inserted = await one<Record<string, unknown>>(
      this.db,
      `INSERT INTO "StockConflict" ("integrationId", "shopId", "externalId", "productId", "kind", "base", "local", "remote",
                                    "merged", "resolvedTo", "status", "createdAt")
       VALUES (:integrationId, :shopId, :externalId, :productId, :kind, :base, :local, :remote,
               :merged, :resolvedTo, 'OPEN', :now)
       ON CONFLICT ("integrationId", "externalId", "base", "local", "remote") WHERE "status" = 'OPEN' DO NOTHING
       RETURNING ${COLUMNS}`,
      replacements,
    );
    if (inserted) return { conflict: toConflict(inserted), created: true };
    const existing = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "StockConflict"
        WHERE "integrationId" = :integrationId AND "externalId" = :externalId
          AND "base" = :base AND "local" = :local AND "remote" = :remote AND "status" = 'OPEN'`,
      replacements,
    );
    if (!existing)
      throw new Error('stock conflict vanished between insert and read');
    return { conflict: toConflict(existing), created: false };
  }

  async findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<ConflictRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "StockConflict" WHERE "integrationId" = :integrationId AND "id" = :id`,
      { integrationId, id },
    );
    return r && toConflict(r);
  }

  async dismiss(
    integrationId: string,
    id: string,
    actorId: string | null,
    resolution: string | null,
    now: Date,
  ): Promise<ConflictRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "StockConflict" SET "status" = 'DISMISSED', "dismissedBy" = :actorId, "dismissedAt" = :now,
              "resolution" = :resolution
        WHERE "integrationId" = :integrationId AND "id" = :id AND "status" = 'OPEN'
        RETURNING ${COLUMNS}`,
      { integrationId, id, actorId, resolution, now },
    );
    return r && toConflict(r);
  }

  listPage(
    integrationId: string,
    query: PageQuery & { status?: ConflictStatus },
  ): Promise<ListPage<ConflictRecord>> {
    return keysetPage({
      db: this.db,
      codec: this.codec,
      table: 'StockConflict',
      tsColumn: 'createdAt',
      where: `t."integrationId" = :integrationId ${query.status ? `AND t."status" = :status` : ''}`,
      replacements: { integrationId, status: query.status },
      scope: `conflicts:${integrationId}:${query.status ?? '*'}`,
      query,
      map: toConflict,
    });
  }

  purgeDismissedBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "StockConflict" WHERE "id" IN (
         SELECT "id" FROM "StockConflict"
          WHERE "status" = 'DISMISSED' AND COALESCE("dismissedAt", "createdAt") < :before
          ORDER BY COALESCE("dismissedAt", "createdAt") LIMIT :limit) RETURNING 1`,
      { before, limit },
    );
  }

  expireOpenBefore(before: Date, now: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `UPDATE "StockConflict" SET "status" = 'DISMISSED', "resolution" = 'expired', "dismissedAt" = :now
        WHERE "id" IN (SELECT "id" FROM "StockConflict" WHERE "status" = 'OPEN' AND "createdAt" < :before
                        ORDER BY "createdAt" LIMIT :limit) RETURNING 1`,
      { before, now, limit },
    );
  }

  async countAllOpen(): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "StockConflict" WHERE "status" = 'OPEN'`,
    );
    return Number(r?.n ?? 0);
  }

  async countOpen(integrationId: string): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "StockConflict" WHERE "integrationId" = :integrationId AND "status" = 'OPEN'`,
      { integrationId },
    );
    return Number(r?.n ?? 0);
  }
}
