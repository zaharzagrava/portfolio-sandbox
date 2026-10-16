import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  ActiveEntitlement,
  EntitlementRecord,
  EntitlementRepository,
  NewEntitlement,
  PurchaseRow,
} from '../domain/ports';
import { count, exec, num, one, rows } from './sql';

const COLUMNS = `e."id", e."orderId", e."productId", e."shopId", e."buyerId", e."assetId", e."title", e."status", e."grantedAt"`;
const RETURNED = `"id", "orderId", "productId", "shopId", "buyerId", "assetId", "title", "status", "grantedAt"`;

/** `AssetEntitlement` and `AssetOrderRevocation` (own tables). */
@Injectable()
export class SequelizeEntitlementRepository implements EntitlementRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async lockOrder(orderId: string): Promise<void> {
    await exec(
      this.db,
      `SELECT pg_advisory_xact_lock(hashtextextended($key, 31))`,
      {
        key: `asset-entitlement:${orderId}`,
      },
    );
  }

  async hasRevocation(orderId: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        `SELECT 1 FROM "AssetOrderRevocation" WHERE "orderId" = $orderId`,
        { orderId },
      )) > 0
    );
  }

  async recordRevocation(input: {
    orderId: string;
    orderVersion: number;
    now: Date;
  }): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO "AssetOrderRevocation" ("orderId", "orderVersion", "revokedAt") VALUES ($orderId, $orderVersion, $now)
       ON CONFLICT ("orderId") DO UPDATE SET "orderVersion" = GREATEST("AssetOrderRevocation"."orderVersion", EXCLUDED."orderVersion")`,
      input,
    );
  }

  insertMany(input: {
    orderId: string;
    buyerId: string;
    entitlements: NewEntitlement[];
    now: Date;
  }): Promise<EntitlementRecord[]> {
    if (input.entitlements.length === 0) return Promise.resolve([]);
    return rows<EntitlementRecord>(
      this.db,
      `INSERT INTO "AssetEntitlement" ("id", "orderId", "productId", "shopId", "buyerId", "assetId", "title", "status", "grantedAt", "downloadCount")
       SELECT t.id, $orderId::uuid, t."productId", t."shopId", $buyerId, t."assetId", t.title, 'ACTIVE', $now, 0
         FROM unnest($ids::uuid[], $productIds::uuid[], $shopIds::uuid[], $assetIds::uuid[], $titles::text[])
              AS t(id, "productId", "shopId", "assetId", title)
       ON CONFLICT ("orderId", "productId") DO NOTHING
       RETURNING ${RETURNED}`,
      {
        orderId: input.orderId,
        buyerId: input.buyerId,
        now: input.now,
        ids: input.entitlements.map((e) => e.id),
        productIds: input.entitlements.map((e) => e.productId),
        shopIds: input.entitlements.map((e) => e.shopId),
        assetIds: input.entitlements.map((e) => e.assetId),
        titles: input.entitlements.map((e) => e.title),
      },
    );
  }

  revokeOfOrder(
    orderId: string,
    reason: 'refunded' | 'shop_deleted',
    now: Date,
  ): Promise<EntitlementRecord[]> {
    return rows<EntitlementRecord>(
      this.db,
      `UPDATE "AssetEntitlement" SET "status" = 'REVOKED', "revokedReason" = $reason, "revokedAt" = $now
        WHERE "orderId" = $orderId AND "status" = 'ACTIVE' RETURNING ${RETURNED}`,
      { orderId, reason, now },
    );
  }

  revokeOfShop(
    shopId: string,
    reason: 'refunded' | 'shop_deleted',
    now: Date,
  ): Promise<EntitlementRecord[]> {
    return rows<EntitlementRecord>(
      this.db,
      `UPDATE "AssetEntitlement" SET "status" = 'REVOKED', "revokedReason" = $reason, "revokedAt" = $now
        WHERE "shopId" = $shopId AND "status" = 'ACTIVE' RETURNING ${RETURNED}`,
      { shopId, reason, now },
    );
  }

  async anyOfProduct(productId: string): Promise<boolean> {
    return (
      (await count(
        this.db,
        `SELECT 1 FROM "AssetEntitlement" WHERE "productId" = $productId LIMIT 1`,
        { productId },
      )) > 0
    );
  }

  async moveToAsset(productId: string, assetId: string): Promise<number> {
    return count(
      this.db,
      `UPDATE "AssetEntitlement" SET "assetId" = $assetId WHERE "productId" = $productId AND "status" = 'ACTIVE' RETURNING 1`,
      { productId, assetId },
    );
  }

  async purchases(input: {
    buyerId: string;
    limit: number;
    after: { at: Date; id: string } | null;
  }): Promise<PurchaseRow[]> {
    const found = await rows<PurchaseRow & { sizeBytes: string | null }>(
      this.db,
      `SELECT e."id" AS "entitlementId", e."productId", e."shopId", e."orderId", e."title", a."path", v."sizeBytes", e."grantedAt"
         FROM "AssetEntitlement" e
         JOIN "Asset" a ON a."id" = e."assetId"
         LEFT JOIN "AssetVersion" v ON v."assetId" = a."id" AND v."version" = a."currentVersion"
        WHERE e."buyerId" = $buyerId AND e."status" = 'ACTIVE'
          AND ($afterAt::timestamptz IS NULL OR (e."grantedAt", e."id") < ($afterAt::timestamptz, $afterId::uuid))
        ORDER BY e."grantedAt" DESC, e."id" DESC
        LIMIT $limit`,
      {
        buyerId: input.buyerId,
        limit: input.limit,
        afterAt: input.after?.at ?? null,
        afterId: input.after?.id ?? null,
      },
    );
    return found.map((r) => ({ ...r, sizeBytes: num(r.sizeBytes) }));
  }

  findActive(
    buyerId: string,
    productId: string,
  ): Promise<ActiveEntitlement | null> {
    return one<ActiveEntitlement>(
      this.db,
      `SELECT ${COLUMNS}, a."status" AS "assetStatus", a."currentVersion"
         FROM "AssetEntitlement" e JOIN "Asset" a ON a."id" = e."assetId"
        WHERE e."buyerId" = $buyerId AND e."productId" = $productId AND e."status" = 'ACTIVE'
        ORDER BY e."grantedAt" DESC, e."id" DESC LIMIT 1`,
      { buyerId, productId },
    );
  }

  async recordDownload(entitlementId: string, now: Date): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "AssetEntitlement" SET "downloadCount" = "downloadCount" + 1, "lastDownloadAt" = $now
          WHERE "id" = $entitlementId AND "status" = 'ACTIVE' RETURNING 1`,
        { entitlementId, now },
      )) > 0
    );
  }
}
