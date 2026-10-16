import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { JournalEntry, JournalRepository } from '../domain/ports';
import { exec, num, one, rows } from './sql';

/**
 * `AssetSyncState` and `AssetChange` (own tables). The number comes from a locked counter row (D4): writers of one shop
 * serialize on it, so numbers are gapless and in commit order, and a reader sees a number only once it committed.
 */
@Injectable()
export class SequelizeJournalRepository implements JournalRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async nextSeq(shopId: string): Promise<number> {
    const r = await one<{ lastSeq: string }>(
      this.db,
      `INSERT INTO "AssetSyncState" ("shopId", "lastSeq") VALUES ($shopId, 1)
       ON CONFLICT ("shopId") DO UPDATE SET "lastSeq" = "AssetSyncState"."lastSeq" + 1
       RETURNING "lastSeq"`,
      { shopId },
    );
    return num(r?.lastSeq);
  }

  async append(input: {
    shopId: string;
    seq: number;
    assetId: string;
    path: string;
    version: number;
    kind: 'upsert' | 'delete';
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetChange" ("shopId", "seq", "assetId", "path", "version", "kind", "at")
       VALUES ($shopId, $seq, $assetId, $path, $version, $kind, $now)`,
      input,
    );
  }

  async lastSeq(shopId: string): Promise<number> {
    const r = await one<{ lastSeq: string }>(
      this.db,
      `SELECT "lastSeq" FROM "AssetSyncState" WHERE "shopId" = $shopId`,
      { shopId },
    );
    return num(r?.lastSeq);
  }

  async minSeq(shopId: string): Promise<number> {
    const r = await one<{ minSeq: string }>(
      this.db,
      `SELECT "minSeq" FROM "AssetSyncState" WHERE "shopId" = $shopId`,
      { shopId },
    );
    return num(r?.minSeq);
  }

  async after(
    shopId: string,
    seq: number,
    limit: number,
  ): Promise<JournalEntry[]> {
    const found = await rows<JournalEntry & { seq: string }>(
      this.db,
      `SELECT "seq", "assetId", "path", "version", "kind" FROM "AssetChange"
        WHERE "shopId" = $shopId AND "seq" > $seq ORDER BY "seq" LIMIT $limit`,
      { shopId, seq, limit },
    );
    return found.map((r) => ({ ...r, seq: num(r.seq) }));
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const r = await one<{ removed: string }>(
      this.db,
      `WITH gone AS (DELETE FROM "AssetChange" WHERE "at" < $cutoff RETURNING "shopId", "seq"),
            floor AS (SELECT "shopId", max("seq") AS top FROM gone GROUP BY "shopId"),
            moved AS (
              UPDATE "AssetSyncState" s SET "minSeq" = GREATEST(s."minSeq", floor.top)
                FROM floor WHERE s."shopId" = floor."shopId" RETURNING 1)
       SELECT (SELECT count(*) FROM gone) AS removed, (SELECT count(*) FROM moved) AS touched`,
      { cutoff },
    );
    return num(r?.removed);
  }

  async removeShop(shopId: string): Promise<void> {
    await exec(this.db, `DELETE FROM "AssetChange" WHERE "shopId" = $shopId`, {
      shopId,
    });
    await exec(
      this.db,
      `DELETE FROM "AssetSyncState" WHERE "shopId" = $shopId`,
      { shopId },
    );
  }
}
