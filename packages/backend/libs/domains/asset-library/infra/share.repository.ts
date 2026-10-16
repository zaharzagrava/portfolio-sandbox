import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ShareLinkRecord,
  ShareRepository,
  ShareTarget,
} from '../domain/ports';
import { exec, one, rows } from './sql';

const LINK = `l."id", l."shopId", l."assetId", l."expiresAt", l."maxDownloads", l."downloads", l."createdBy", l."createdAt", l."revokedAt"`;
const TARGET = `${LINK}, a."status" AS "assetStatus", a."path", a."currentVersion"`;

/** `AssetShareLink` (own table). Only the digest of a token is stored. */
@Injectable()
export class SequelizeShareRepository implements ShareRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async insert(input: {
    id: string;
    shopId: string;
    assetId: string;
    tokenHash: string;
    createdBy: string;
    expiresAt: Date;
    maxDownloads: number | null;
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetShareLink" ("id", "shopId", "assetId", "tokenHash", "createdBy", "expiresAt", "maxDownloads", "downloads", "createdAt")
       VALUES ($id, $shopId, $assetId, $tokenHash, $createdBy, $expiresAt, $maxDownloads, 0, $now)`,
      input,
    );
  }

  listOfAsset(shopId: string, assetId: string): Promise<ShareLinkRecord[]> {
    return rows<ShareLinkRecord>(
      this.db,
      `SELECT ${LINK} FROM "AssetShareLink" l
        WHERE l."shopId" = $shopId AND l."assetId" = $assetId ORDER BY l."createdAt", l."id"`,
      { shopId, assetId },
    );
  }

  findOfAsset(
    shopId: string,
    assetId: string,
    linkId: string,
  ): Promise<ShareLinkRecord | null> {
    return one<ShareLinkRecord>(
      this.db,
      `SELECT ${LINK} FROM "AssetShareLink" l
        WHERE l."id" = $linkId AND l."shopId" = $shopId AND l."assetId" = $assetId`,
      { shopId, assetId, linkId },
    );
  }

  async revoke(linkId: string, now: Date): Promise<boolean> {
    return (
      (
        await rows<unknown>(
          this.db,
          `UPDATE "AssetShareLink" SET "revokedAt" = $now WHERE "id" = $linkId AND "revokedAt" IS NULL RETURNING 1`,
          { linkId, now },
        )
      ).length > 0
    );
  }

  findByTokenHash(tokenHash: string): Promise<ShareTarget | null> {
    return one<ShareTarget>(
      this.db,
      `SELECT ${TARGET} FROM "AssetShareLink" l JOIN "Asset" a ON a."id" = l."assetId" WHERE l."tokenHash" = $tokenHash`,
      { tokenHash },
    );
  }

  redeem(tokenHash: string, now: Date): Promise<ShareTarget | null> {
    return one<ShareTarget>(
      this.db,
      `WITH hit AS (
         UPDATE "AssetShareLink" l SET "downloads" = l."downloads" + 1
           FROM "Asset" a
          WHERE l."tokenHash" = $tokenHash AND a."id" = l."assetId" AND a."status" = 'ACTIVE'
            AND l."revokedAt" IS NULL AND l."expiresAt" > $now
            AND (l."maxDownloads" IS NULL OR l."downloads" < l."maxDownloads")
        RETURNING ${LINK}, a."status" AS "assetStatus", a."path", a."currentVersion")
       SELECT * FROM hit`,
      { tokenHash, now },
    );
  }
}
