import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ChunkDeltaInput,
  ChunkRecord,
  ChunkRepository,
} from '../domain/ports';
import { exec, num, one, rows } from './sql';

const COLUMNS = `"hash", "size", "refCount", "storedAt", "protectedUntil", "deleting", "reserved", "unreferencedSince"`;

/** `AssetChunk` (own table): per-shop, content-addressed, reference counted. */
@Injectable()
export class SequelizeChunkRepository implements ChunkRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  findMany(shopId: string, hashes: string[]): Promise<ChunkRecord[]> {
    return rows<ChunkRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "AssetChunk" WHERE "shopId" = $shopId AND "hash" = ANY($hashes::text[])`,
      { shopId, hashes },
    );
  }

  lockMany(shopId: string, hashes: string[]): Promise<ChunkRecord[]> {
    return rows<ChunkRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "AssetChunk" WHERE "shopId" = $shopId AND "hash" = ANY($hashes::text[])
        ORDER BY "hash" FOR UPDATE`,
      { shopId, hashes },
    );
  }

  insertPlaceholders(input: {
    shopId: string;
    chunks: { hash: string; size: number }[];
    now: Date;
    protectedUntil: Date;
  }): Promise<{ hash: string; size: number }[]> {
    if (input.chunks.length === 0) return Promise.resolve([]);
    return rows<{ hash: string; size: number }>(
      this.db,
      `INSERT INTO "AssetChunk" ("shopId", "hash", "size", "refCount", "unreferencedSince", "protectedUntil", "reserved", "deleting")
       SELECT $shopId, t.hash, t.size, 0, $now, $protectedUntil, true, false
         FROM unnest($hashes::text[], $sizes::int[]) AS t(hash, size)
        ORDER BY t.hash
       ON CONFLICT ("shopId", "hash") DO NOTHING
       RETURNING "hash", "size"`,
      {
        shopId: input.shopId,
        hashes: input.chunks.map((c) => c.hash),
        sizes: input.chunks.map((c) => c.size),
        now: input.now,
        protectedUntil: input.protectedUntil,
      },
    );
  }

  async confirmStored(
    shopId: string,
    hashes: string[],
    now: Date,
    protectedUntil: Date,
  ): Promise<{ storedBytes: number; fromReservedBytes: number }> {
    const r = await one<{ stored: string | null; reserved: string | null }>(
      this.db,
      `WITH old AS (
         SELECT "hash", "size", "reserved" FROM "AssetChunk"
          WHERE "shopId" = $shopId AND "hash" = ANY($hashes::text[]) AND "storedAt" IS NULL
          ORDER BY "hash" FOR UPDATE),
       upd AS (
         UPDATE "AssetChunk" c
            SET "storedAt" = $now, "reserved" = false,
                "protectedUntil" = GREATEST(COALESCE(c."protectedUntil", $protectedUntil), $protectedUntil)
           FROM old WHERE c."shopId" = $shopId AND c."hash" = old."hash"
        RETURNING old."size", old."reserved")
       SELECT sum("size") AS stored, sum("size") FILTER (WHERE "reserved") AS reserved FROM upd`,
      { shopId, hashes, now, protectedUntil },
    );
    return { storedBytes: num(r?.stored), fromReservedBytes: num(r?.reserved) };
  }

  async markNotStored(
    shopId: string,
    hashes: string[],
    protectedUntil: Date,
  ): Promise<number> {
    const r = await one<{ moved: string | null }>(
      this.db,
      `WITH upd AS (
         UPDATE "AssetChunk"
            SET "storedAt" = NULL, "reserved" = true, "protectedUntil" = $protectedUntil
          WHERE "shopId" = $shopId AND "hash" = ANY($hashes::text[])
            AND "refCount" = 0 AND "storedAt" IS NOT NULL AND NOT "reserved"
        RETURNING "size")
       SELECT sum("size") AS moved FROM upd`,
      { shopId, hashes, protectedUntil },
    );
    return num(r?.moved);
  }

  async protect(
    shopId: string,
    hashes: string[],
    protectedUntil: Date,
  ): Promise<void> {
    if (hashes.length === 0) return;
    await exec(
      this.db,
      `UPDATE "AssetChunk"
          SET "protectedUntil" = GREATEST(COALESCE("protectedUntil", $protectedUntil), $protectedUntil)
        WHERE "shopId" = $shopId AND "hash" = ANY($hashes::text[])`,
      { shopId, hashes, protectedUntil },
    );
  }

  adjust(input: {
    shopId: string;
    deltas: ChunkDeltaInput[];
    now: Date;
    protectedUntil: Date;
  }): Promise<{ hash: string; refCount: number }[]> {
    if (input.deltas.length === 0) return Promise.resolve([]);
    return rows<{ hash: string; refCount: number }>(
      this.db,
      `UPDATE "AssetChunk" c
          SET "refCount" = c."refCount" + d.delta,
              "unreferencedSince" = CASE WHEN c."refCount" + d.delta = 0 THEN $now::timestamptz ELSE NULL END,
              "protectedUntil" = CASE WHEN d.delta > 0
                THEN GREATEST(COALESCE(c."protectedUntil", $protectedUntil::timestamptz), $protectedUntil::timestamptz)
                ELSE c."protectedUntil" END
         FROM unnest($hashes::text[], $deltas::int[]) AS d(hash, delta)
        WHERE c."shopId" = $shopId AND c."hash" = d.hash
       RETURNING c."hash", c."refCount"`,
      {
        shopId: input.shopId,
        hashes: input.deltas.map((d) => d.hash),
        deltas: input.deltas.map((d) => d.delta),
        now: input.now,
        protectedUntil: input.protectedUntil,
      },
    );
  }

  claimForCleanup(input: {
    unreferencedBefore: Date;
    protectedBefore: Date;
    limit: number;
  }): Promise<(ChunkRecord & { shopId: string })[]> {
    return rows<ChunkRecord & { shopId: string }>(
      this.db,
      `WITH picked AS (
         SELECT "shopId", "hash" FROM "AssetChunk"
          WHERE "refCount" = 0 AND NOT "deleting"
            AND "unreferencedSince" < $unreferencedBefore
            AND ("protectedUntil" IS NULL OR "protectedUntil" < $protectedBefore)
          ORDER BY "unreferencedSince" LIMIT $limit FOR UPDATE SKIP LOCKED)
       UPDATE "AssetChunk" c SET "deleting" = true
         FROM picked p WHERE c."shopId" = p."shopId" AND c."hash" = p."hash"
       RETURNING c."shopId", c."hash", c."size", c."refCount", c."storedAt", c."protectedUntil", c."deleting", c."reserved", c."unreferencedSince"`,
      input as unknown as Record<string, unknown>,
    );
  }

  async releaseClaim(shopId: string, hash: string): Promise<void> {
    await exec(
      this.db,
      `UPDATE "AssetChunk" SET "deleting" = false WHERE "shopId" = $shopId AND "hash" = $hash`,
      { shopId, hash },
    );
  }

  deleteClaimed(
    shopId: string,
    hash: string,
  ): Promise<(ChunkRecord & { shopId: string }) | null> {
    return one<ChunkRecord & { shopId: string }>(
      this.db,
      `DELETE FROM "AssetChunk" WHERE "shopId" = $shopId AND "hash" = $hash AND "deleting" AND "refCount" = 0
       RETURNING "shopId", ${COLUMNS}`,
      { shopId, hash },
    );
  }

  claimAllOfShop(
    shopId: string,
    limit: number,
  ): Promise<(ChunkRecord & { shopId: string })[]> {
    return rows<ChunkRecord & { shopId: string }>(
      this.db,
      `WITH picked AS (
         SELECT "shopId", "hash" FROM "AssetChunk"
          WHERE "shopId" = $shopId ORDER BY "hash" LIMIT $limit FOR UPDATE SKIP LOCKED)
       UPDATE "AssetChunk" c
          SET "deleting" = true, "refCount" = 0, "unreferencedSince" = '-infinity', "protectedUntil" = NULL
         FROM picked p WHERE c."shopId" = p."shopId" AND c."hash" = p."hash"
       RETURNING c."shopId", c."hash", c."size", c."refCount", c."storedAt", c."protectedUntil", c."deleting", c."reserved", c."unreferencedSince"`,
      { shopId, limit },
    );
  }
}
