import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  GrantRecord,
  GrantRepository,
  ResolvedGrant,
} from '../domain/ports';
import { exec, num, one } from './sql';

/** `AssetDownloadGrant` (own table): opaque, short-lived, version-pinned; only the digest is stored. */
@Injectable()
export class SequelizeGrantRepository implements GrantRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async insert(grant: GrantRecord): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetDownloadGrant"
         ("tokenHash", "kind", "shopId", "assetId", "version", "shareLinkId", "entitlementId", "buyerId", "expiresAt", "createdAt")
       VALUES ($tokenHash, $kind, $shopId, $assetId, $version, $shareLinkId, $entitlementId, $buyerId, $expiresAt, $createdAt)`,
      { ...grant },
    );
  }

  resolve(tokenHash: string): Promise<ResolvedGrant | null> {
    return one<ResolvedGrant>(
      this.db,
      `SELECT g."tokenHash", g."kind", g."shopId", g."assetId", g."version", g."shareLinkId", g."entitlementId",
              g."buyerId", g."expiresAt", g."createdAt",
              a."status" AS "assetStatus", a."path",
              l."revokedAt" AS "linkRevokedAt", (l."id" IS NOT NULL) AS "linkFound",
              e."status" AS "entitlementStatus"
         FROM "AssetDownloadGrant" g
         JOIN "Asset" a ON a."id" = g."assetId"
         LEFT JOIN "AssetShareLink" l ON l."id" = g."shareLinkId"
         LEFT JOIN "AssetEntitlement" e ON e."id" = g."entitlementId"
        WHERE g."tokenHash" = $tokenHash`,
      { tokenHash },
    );
  }

  async purgeExpired(cutoff: Date): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `WITH gone AS (DELETE FROM "AssetDownloadGrant" WHERE "expiresAt" < $cutoff RETURNING 1)
       SELECT count(*) AS n FROM gone`,
      { cutoff },
    );
    return num(r?.n);
  }
}
