import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ChunkOccurrenceInput,
  VersionRecord,
  VersionRepository,
  VersionSummary,
} from '../domain/ports';
import { exec, num, one, rows } from './sql';

interface VersionRow {
  assetId: string;
  version: number;
  sizeBytes: string;
  chunks: string[];
  createdBy: string | null;
  deviceId: string | null;
  createdAt: Date;
}

const toRecord = (r: VersionRow): VersionRecord => ({
  ...r,
  sizeBytes: num(r.sizeBytes),
  // hashes are CHAR(64): exactly 64 characters, so no padding to trim
  chunks: r.chunks,
});

/** `AssetVersion` and `AssetVersionChunk` (own tables). */
@Injectable()
export class SequelizeVersionRepository implements VersionRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async insert(input: {
    assetId: string;
    shopId: string;
    version: number;
    sizeBytes: number;
    chunks: string[];
    occurrences: ChunkOccurrenceInput[];
    createdBy: string;
    deviceId: string;
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetVersion" ("assetId", "version", "sizeBytes", "chunks", "createdBy", "deviceId", "createdAt")
       VALUES ($assetId, $version, $sizeBytes, $chunks::text[], $createdBy, $deviceId, $now)`,
      {
        assetId: input.assetId,
        version: input.version,
        sizeBytes: input.sizeBytes,
        chunks: input.chunks,
        createdBy: input.createdBy,
        deviceId: input.deviceId,
        now: input.now,
      },
    );
    if (input.occurrences.length === 0) return;
    await exec(
      this.db,
      `INSERT INTO "AssetVersionChunk" ("assetId", "version", "hash", "shopId", "occurrences")
       SELECT $assetId, $version, t.hash, $shopId, t.occ FROM unnest($hashes::text[], $occ::int[]) AS t(hash, occ)`,
      {
        assetId: input.assetId,
        version: input.version,
        shopId: input.shopId,
        hashes: input.occurrences.map((o) => o.hash),
        occ: input.occurrences.map((o) => o.occurrences),
      },
    );
  }

  async find(assetId: string, version: number): Promise<VersionRecord | null> {
    const r = await one<VersionRow>(
      this.db,
      `SELECT "assetId", "version", "sizeBytes", "chunks", "createdBy", "deviceId", "createdAt"
         FROM "AssetVersion" WHERE "assetId" = $assetId AND "version" = $version`,
      { assetId, version },
    );
    return r ? toRecord(r) : null;
  }

  async count(assetId: string): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "AssetVersion" WHERE "assetId" = $assetId`,
      { assetId },
    );
    return num(r?.n);
  }

  async page(
    assetId: string,
    limit: number,
    before: number | null,
  ): Promise<VersionSummary[]> {
    const found = await rows<{
      version: number;
      sizeBytes: string;
      chunkCount: number;
      createdBy: string | null;
      deviceId: string | null;
      createdAt: Date;
    }>(
      this.db,
      `SELECT "version", "sizeBytes", cardinality("chunks") AS "chunkCount", "createdBy", "deviceId", "createdAt"
         FROM "AssetVersion"
        WHERE "assetId" = $assetId AND ($before::int IS NULL OR "version" < $before::int)
        ORDER BY "version" DESC LIMIT $limit`,
      { assetId, before, limit },
    );
    return found.map((r) => ({ ...r, sizeBytes: num(r.sizeBytes) }));
  }

  async remove(
    assetId: string,
    version: number,
  ): Promise<VersionRecord | null> {
    const removed = await one<VersionRow>(
      this.db,
      `DELETE FROM "AssetVersion" WHERE "assetId" = $assetId AND "version" = $version
       RETURNING "assetId", "version", "sizeBytes", "chunks", "createdBy", "deviceId", "createdAt"`,
      { assetId, version },
    );
    if (!removed) return null;
    await exec(
      this.db,
      `DELETE FROM "AssetVersionChunk" WHERE "assetId" = $assetId AND "version" = $version`,
      { assetId, version },
    );
    return toRecord(removed);
  }

  async removeAll(assetId: string): Promise<VersionRecord[]> {
    const removed = await rows<VersionRow>(
      this.db,
      `DELETE FROM "AssetVersion" WHERE "assetId" = $assetId
       RETURNING "assetId", "version", "sizeBytes", "chunks", "createdBy", "deviceId", "createdAt"`,
      { assetId },
    );
    await exec(
      this.db,
      `DELETE FROM "AssetVersionChunk" WHERE "assetId" = $assetId`,
      { assetId },
    );
    return removed.map(toRecord);
  }
}
