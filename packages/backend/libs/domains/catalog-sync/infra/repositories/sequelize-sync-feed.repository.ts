import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type {
  FeedEntry,
  FeedEntryInput,
  FeedState,
  SyncFeedRepository,
} from '../../domain/ports';
import { count, json, one, rows, toDate } from './sql';

/**
 * `ShopChangeLog` and `ShopSyncState` (own tables). Writers of one shop serialise on the state row, which is what makes
 * the committed `seq` values exactly `1…lastSeq` and an entry visible only when every smaller one is (R-05).
 */
@Injectable()
export class SequelizeSyncFeedRepository implements SyncFeedRepository {
  constructor(
    @InjectConnection() private readonly db: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  append(
    shopId: string,
    entry: FeedEntryInput,
  ): Promise<'appended' | 'duplicate' | 'stale'> {
    return this.transactions.run(async () => {
      await count(
        this.db,
        `INSERT INTO "ShopSyncState" ("shopId", "lastSeq", "generation") VALUES (:shopId, 0, 0)
         ON CONFLICT ("shopId") DO NOTHING RETURNING 1`,
        { shopId },
      );
      const state = await one<{ lastSeq: string }>(
        this.db,
        `SELECT "lastSeq" FROM "ShopSyncState" WHERE "shopId" = :shopId FOR UPDATE`,
        { shopId },
      );
      const known = await one<{ same: boolean; newest: number | null }>(
        this.db,
        `SELECT bool_or("version" = :version) AS same, max("version") AS newest
           FROM "ShopChangeLog" WHERE "shopId" = :shopId AND "entityId" = :productId`,
        { shopId, productId: entry.productId, version: entry.version },
      );
      if (known?.same) return 'duplicate' as const;
      if (
        known?.newest !== null &&
        known &&
        Number(known.newest) > entry.version
      )
        return 'stale' as const;
      const seq = Number(state!.lastSeq) + 1;
      await count(
        this.db,
        `INSERT INTO "ShopChangeLog" ("shopId", "seq", "entity", "entityId", "version", "deleted", "data", "occurredAt")
         VALUES (:shopId, :seq, 'product', :productId, :version, :deleted, CAST(:data AS jsonb), :occurredAt) RETURNING 1`,
        {
          shopId,
          seq,
          productId: entry.productId,
          version: entry.version,
          deleted: entry.deleted,
          data: entry.data ? json(entry.data) : null,
          occurredAt: entry.occurredAt,
        },
      );
      await count(
        this.db,
        `UPDATE "ShopSyncState" SET "lastSeq" = :seq, "updatedAt" = now() WHERE "shopId" = :shopId RETURNING 1`,
        { shopId, seq },
      );
      return 'appended' as const;
    });
  }

  async page(
    shopId: string,
    afterSeq: number,
    limit: number,
    options: { latestOnly?: boolean } = {},
  ): Promise<FeedEntry[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT e."seq", e."entityId", e."version", e."deleted", e."data"
         FROM "ShopChangeLog" e
        WHERE e."shopId" = :shopId AND e."seq" > :afterSeq AND e."version" IS NOT NULL
          ${
            options.latestOnly
              ? `AND NOT EXISTS (SELECT 1 FROM "ShopChangeLog" n
                                  WHERE n."shopId" = e."shopId" AND n."entityId" = e."entityId" AND n."version" > e."version")`
              : ''
          }
        ORDER BY e."seq" LIMIT :limit`,
      { shopId, afterSeq, limit },
    );
    return found.map((r) => ({
      seq: Number(r.seq),
      productId: r.entityId as string,
      version: Number(r.version),
      deleted: r.deleted as boolean,
      data: (r.data ?? null) as FeedEntry['data'],
    }));
  }

  async state(shopId: string): Promise<FeedState | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT "lastSeq", "generation", "horizonSeq", "horizonAt" FROM "ShopSyncState" WHERE "shopId" = :shopId`,
      { shopId },
    );
    return r
      ? {
          lastSeq: Number(r.lastSeq),
          generation: Number(r.generation),
          horizonSeq: Number(r.horizonSeq),
          horizonAt: toDate(r.horizonAt),
        }
      : null;
  }

  compact(
    shopId: string,
    before: Date,
    limit: number,
    now: Date,
  ): Promise<{ removed: number; horizonSeq: number }> {
    return this.transactions.run(async () => {
      // Lock the state row first: compaction and appends of one shop never interleave.
      const state = await one<{ horizonSeq: string }>(
        this.db,
        `SELECT "horizonSeq" FROM "ShopSyncState" WHERE "shopId" = :shopId FOR UPDATE`,
        { shopId },
      );
      if (!state) return { removed: 0, horizonSeq: 0 };
      const removed = await rows<{ seq: string }>(
        this.db,
        `DELETE FROM "ShopChangeLog" WHERE "shopId" = :shopId AND "seq" IN (
           SELECT e."seq" FROM "ShopChangeLog" e
            WHERE e."shopId" = :shopId AND COALESCE(e."occurredAt", e."at") < :before
              AND (e."deleted" OR EXISTS (SELECT 1 FROM "ShopChangeLog" n
                                           WHERE n."shopId" = e."shopId" AND n."entityId" = e."entityId"
                                             AND n."version" > e."version"))
            ORDER BY e."seq" LIMIT :limit)
         RETURNING "seq"`,
        { shopId, before, limit },
      );
      let horizonSeq = Number(state.horizonSeq);
      if (removed.length > 0) {
        horizonSeq = Math.max(horizonSeq, ...removed.map((r) => Number(r.seq)));
        await count(
          this.db,
          `UPDATE "ShopSyncState" SET "horizonSeq" = :horizonSeq, "horizonAt" = :now, "updatedAt" = now()
            WHERE "shopId" = :shopId RETURNING 1`,
          { shopId, horizonSeq, now },
        );
      }
      return { removed: removed.length, horizonSeq };
    });
  }

  async shopsWithEntriesBefore(
    before: Date,
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const found = await rows<{ shopId: string }>(
      this.db,
      `SELECT DISTINCT "shopId" FROM "ShopChangeLog"
        WHERE COALESCE("occurredAt", "at") < :before AND (CAST(:after AS uuid) IS NULL OR "shopId" > CAST(:after AS uuid))
        ORDER BY "shopId" LIMIT :limit`,
      { before, after, limit },
    );
    return found.map((r) => r.shopId);
  }

  startGeneration(shopId: string): Promise<number> {
    return this.transactions.run(async () => {
      await count(
        this.db,
        `INSERT INTO "ShopSyncState" ("shopId", "lastSeq", "generation") VALUES (:shopId, 0, 0)
         ON CONFLICT ("shopId") DO NOTHING RETURNING 1`,
        { shopId },
      );
      const next = await one<{ generation: number }>(
        this.db,
        `UPDATE "ShopSyncState" SET "generation" = "generation" + 1, "updatedAt" = now()
          WHERE "shopId" = :shopId RETURNING "generation"`,
        { shopId },
      );
      // Entries of the trigger-built feed carry no version: the rebuilt feed replaces them.
      await count(
        this.db,
        `DELETE FROM "ShopChangeLog" WHERE "shopId" = :shopId AND "version" IS NULL RETURNING 1`,
        { shopId },
      );
      return Number(next!.generation);
    });
  }

  async deleteShop(shopId: string, limit: number): Promise<number> {
    const removed = await count(
      this.db,
      `DELETE FROM "ShopChangeLog" WHERE ctid IN (
         SELECT ctid FROM "ShopChangeLog" WHERE "shopId" = :shopId LIMIT :limit) RETURNING 1`,
      { shopId, limit },
    );
    if (removed < limit)
      await count(
        this.db,
        `DELETE FROM "ShopSyncState" WHERE "shopId" = :shopId RETURNING 1`,
        { shopId },
      );
    return removed;
  }
}
