import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  AssetListRow,
  AssetRecord,
  AssetRepository,
  AssetStatus,
} from '../domain/ports';
import { count, exec, num, one, rows } from './sql';

const COLUMNS = `a."id", a."shopId", a."path", a."status", a."currentVersion", a."deletedAt", a."updatedAt", a."createdAt"`;

/** `Asset` (own table). The shop is part of every lookup by ID (FR-045). */
@Injectable()
export class SequelizeAssetRepository implements AssetRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  lockActiveByPath(shopId: string, path: string): Promise<AssetRecord | null> {
    return one<AssetRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "Asset" a WHERE a."shopId" = $shopId AND a."path" = $path AND a."status" = 'ACTIVE' FOR UPDATE`,
      { shopId, path },
    );
  }

  async insertActive(input: {
    id: string;
    shopId: string;
    path: string;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "Asset" ("id", "shopId", "path", "status", "currentVersion", "createdAt", "updatedAt")
         VALUES ($id, $shopId, $path, 'ACTIVE', 0, $now, $now)
         ON CONFLICT ("shopId", "path") WHERE "status" = 'ACTIVE' DO NOTHING RETURNING 1`,
        input,
      )) > 0
    );
  }

  find(shopId: string, assetId: string): Promise<AssetRecord | null> {
    return one<AssetRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "Asset" a WHERE a."id" = $assetId AND a."shopId" = $shopId`,
      { shopId, assetId },
    );
  }

  lock(shopId: string, assetId: string): Promise<AssetRecord | null> {
    return one<AssetRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "Asset" a WHERE a."id" = $assetId AND a."shopId" = $shopId FOR UPDATE`,
      { shopId, assetId },
    );
  }

  async setCurrentVersion(
    assetId: string,
    version: number,
    now: Date,
  ): Promise<void> {
    await count(
      this.db,
      `UPDATE "Asset" SET "currentVersion" = $version, "updatedAt" = $now WHERE "id" = $assetId RETURNING 1`,
      { assetId, version, now },
    );
  }

  async transition(input: {
    shopId: string;
    assetId: string;
    from: AssetStatus;
    to: AssetStatus;
    deletedAt: Date | null;
    now: Date;
  }): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Asset" SET "status" = $to, "deletedAt" = $deletedAt, "updatedAt" = $now
          WHERE "id" = $assetId AND "shopId" = $shopId AND "status" = $from RETURNING 1`,
        input,
      )) > 0
    );
  }

  async removeAllOfShop(shopId: string): Promise<void> {
    await exec(
      this.db,
      `DELETE FROM "AssetDownloadGrant" WHERE "shopId" = $shopId`,
      { shopId },
    );
    await exec(
      this.db,
      `DELETE FROM "AssetShareLink" WHERE "shopId" = $shopId`,
      { shopId },
    );
    await exec(this.db, `DELETE FROM "Asset" WHERE "shopId" = $shopId`, {
      shopId,
    });
  }

  async removeShareArtifacts(assetId: string): Promise<void> {
    await exec(
      this.db,
      `DELETE FROM "AssetDownloadGrant" WHERE "assetId" = $assetId`,
      { assetId },
    );
    await exec(
      this.db,
      `DELETE FROM "AssetShareLink" WHERE "assetId" = $assetId`,
      { assetId },
    );
  }

  async inUse(assetId: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM "DigitalProduct" WHERE "assetId" = $assetId)
            OR EXISTS (SELECT 1 FROM "AssetEntitlement" WHERE "assetId" = $assetId)`,
        { assetId },
      )) > 0
    );
  }

  async activePathsStartingWith(
    shopId: string,
    prefix: string,
  ): Promise<Set<string>> {
    const found = await rows<{ path: string }>(
      this.db,
      `SELECT "path" FROM "Asset" WHERE "shopId" = $shopId AND "status" = 'ACTIVE' AND starts_with("path", $prefix)`,
      { shopId, prefix },
    );
    return new Set(found.map((r) => r.path));
  }

  async listPage(input: {
    shopId: string;
    prefix: string | null;
    deleted: boolean;
    deletedSince: Date;
    limit: number;
    after: { path: string; id: string } | null;
  }): Promise<AssetListRow[]> {
    const found = await rows<AssetListRow & { sizeBytes: string | null }>(
      this.db,
      `SELECT ${COLUMNS}, v."sizeBytes"
         FROM "Asset" a
         LEFT JOIN "AssetVersion" v ON v."assetId" = a."id" AND v."version" = a."currentVersion"
        WHERE a."shopId" = $shopId
          AND a."status" = CASE WHEN $deleted::boolean THEN 'DELETED' ELSE 'ACTIVE' END
          AND (NOT $deleted::boolean OR a."deletedAt" >= $deletedSince)
          AND ($prefix::text IS NULL OR starts_with(a."path", $prefix::text))
          AND ($afterPath::text IS NULL OR (a."path" COLLATE "C", a."id") > ($afterPath::text COLLATE "C", $afterId::uuid))
        ORDER BY a."path" COLLATE "C", a."id"
        LIMIT $limit`,
      {
        shopId: input.shopId,
        deleted: input.deleted,
        deletedSince: input.deletedSince,
        prefix: input.prefix,
        afterPath: input.after?.path ?? null,
        afterId: input.after?.id ?? null,
        limit: input.limit,
      },
    );
    return found.map((r) => ({ ...r, sizeBytes: num(r.sizeBytes) }));
  }

  lockDeletedBefore(cutoff: Date, limit: number): Promise<AssetRecord[]> {
    return rows<AssetRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "Asset" a
        WHERE a."status" = 'DELETED' AND a."deletedAt" < $cutoff
        ORDER BY a."deletedAt" LIMIT $limit FOR UPDATE SKIP LOCKED`,
      { cutoff, limit },
    );
  }

  lockUnpurgedOfShop(shopId: string, limit: number): Promise<AssetRecord[]> {
    return rows<AssetRecord>(
      this.db,
      `SELECT ${COLUMNS} FROM "Asset" a
        WHERE a."shopId" = $shopId AND a."status" <> 'PURGED'
        ORDER BY a."id" LIMIT $limit FOR UPDATE SKIP LOCKED`,
      { shopId, limit },
    );
  }
}
