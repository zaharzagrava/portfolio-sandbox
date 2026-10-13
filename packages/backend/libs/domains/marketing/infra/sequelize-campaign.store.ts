import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { AD_MAX_OPEN_CAMPAIGNS_PER_SHOP } from '@marketplace-sandbox/contracts';
import {
  OpenCampaignExistsError,
  type CampaignListQuery,
  type CampaignRecord,
  type CampaignStore,
  type HistoryEntry,
  type NewCampaign,
  type ServeCandidate,
} from '../domain/ads-ports';
import type { CampaignStatus } from '../domain/campaign-state';
import type { AdStatusReason } from '@marketplace-sandbox/contracts';

const COLUMNS = `c."id", c."shopId", c."productId", c."category", c."cpcMinor", c."dailyBudgetMinor", c."currency",
  c."status", c."statusReason", c."campaignVersion", c."createdAt", c."updatedAt"`;

/**
 * `AdCampaign` and its satellites (history, sponsorship value, shop quota) behind the `CampaignStore` port. Every
 * invariant sits in the statement or the schema (III.6, III.7): the partial unique index for one open campaign per
 * product, a conditional quota upsert for the 50-per-shop limit, a conditional update that must match one row for each
 * transition. The shop is in every predicate (III.4). Statements join the caller's transaction through CLS.
 */
@Injectable()
export class SequelizeCampaignStore implements CampaignStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object = CampaignRecord>(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async insert(campaign: NewCampaign, now: Date): Promise<CampaignRecord> {
    // ON CONFLICT on the partial unique index: a lost race is an empty result, not an error that would abort the
    // surrounding transaction.
    const [row] = await this.select(
      `INSERT INTO "AdCampaign" AS c ("shopId", "productId", "category", "cpcMinor", "dailyBudgetMinor", "createdAt", "updatedAt")
       VALUES (:shopId, :productId, :category, :cpcMinor, :dailyBudgetMinor, :now, :now)
       ON CONFLICT ("productId") WHERE "status" <> 'ENDED' DO NOTHING
       RETURNING ${COLUMNS}`,
      { ...campaign, now },
    );
    if (!row) throw new OpenCampaignExistsError();
    return row;
  }

  async findForShop(
    id: string,
    shopId: string,
  ): Promise<CampaignRecord | null> {
    const [row] = await this.select(
      `SELECT ${COLUMNS} FROM "AdCampaign" c WHERE c."id" = :id AND c."shopId" = :shopId`,
      { id, shopId },
    );
    return row ?? null;
  }

  findManyByIds(ids: string[]): Promise<CampaignRecord[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.select(
      `SELECT ${COLUMNS} FROM "AdCampaign" c WHERE c."id" IN (:ids) ORDER BY c."id"`,
      { ids },
    );
  }

  list(shopId: string, query: CampaignListQuery): Promise<CampaignRecord[]> {
    return this.select(
      `SELECT ${COLUMNS} FROM "AdCampaign" c
        WHERE c."shopId" = :shopId
          AND (CAST(:status AS TEXT) IS NULL OR c."status" = :status)
          AND (CAST(:afterAt AS TIMESTAMPTZ) IS NULL OR (c."createdAt", c."id") < (CAST(:afterAt AS TIMESTAMPTZ), CAST(:afterId AS UUID)))
        ORDER BY c."createdAt" DESC, c."id" DESC
        LIMIT :limit`,
      {
        shopId,
        status: query.status ?? null,
        afterAt: query.after?.createdAt ?? null,
        afterId: query.after?.id ?? null,
        limit: query.limit,
      },
    );
  }

  async transition(
    id: string,
    shopId: string,
    from: CampaignStatus,
    to: CampaignStatus,
    reason: AdStatusReason | null,
    now: Date,
  ): Promise<CampaignRecord | null> {
    const [row] = await this.select(
      `UPDATE "AdCampaign" c SET "status" = :to, "statusReason" = :reason,
              "campaignVersion" = c."campaignVersion" + 1, "updatedAt" = :now
        WHERE c."id" = :id AND c."shopId" = :shopId AND c."status" = :from
        RETURNING ${COLUMNS}`,
      { id, shopId, from, to, reason, now },
    );
    return row ?? null;
  }

  async appendHistory(entry: HistoryEntry, now: Date): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "AdCampaignHistory" ("campaignId", "actorId", "fromStatus", "toStatus", "reason", "campaignVersion", "createdAt")
       VALUES (:campaignId, :actorId, :from, :to, :reason, :campaignVersion, :now)`,
      { replacements: { ...entry, now } },
    );
  }

  async reserveQuota(shopId: string): Promise<boolean> {
    const rows = await this.select(
      `INSERT INTO "AdShopQuota" AS q ("shopId", "openCount") VALUES (:shopId, 1)
       ON CONFLICT ("shopId") DO UPDATE SET "openCount" = q."openCount" + 1 WHERE q."openCount" < :max
       RETURNING q."openCount"`,
      { shopId, max: AD_MAX_OPEN_CAMPAIGNS_PER_SHOP },
    );
    return rows.length > 0;
  }

  async releaseQuota(shopId: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "AdShopQuota" SET "openCount" = GREATEST("openCount" - 1, 0) WHERE "shopId" = :shopId`,
      { replacements: { shopId } },
    );
  }

  async setSponsorship(
    productId: string,
    shopId: string,
    sponsored: boolean,
    now: Date,
  ): Promise<number | null> {
    const [changed] = await this.select<{ sponsorshipVersion: number }>(
      `UPDATE "AdProductSponsorship" SET "sponsored" = :sponsored, "shopId" = :shopId,
              "sponsorshipVersion" = "sponsorshipVersion" + 1, "updatedAt" = :now
        WHERE "productId" = :productId AND "sponsored" <> :sponsored
        RETURNING "sponsorshipVersion"`,
      { productId, shopId, sponsored, now },
    );
    if (changed) return changed.sponsorshipVersion;
    const [first] = await this.select<{ sponsorshipVersion: number }>(
      `INSERT INTO "AdProductSponsorship" ("productId", "shopId", "sponsored", "sponsorshipVersion", "updatedAt")
       VALUES (:productId, :shopId, :sponsored, 1, :now)
       ON CONFLICT ("productId") DO NOTHING
       RETURNING "sponsorshipVersion"`,
      { productId, shopId, sponsored, now },
    );
    return first?.sponsorshipVersion ?? null;
  }

  openByProduct(productId: string): Promise<CampaignRecord[]> {
    return this.select(
      `SELECT ${COLUMNS} FROM "AdCampaign" c WHERE c."productId" = :productId AND c."status" <> 'ENDED' ORDER BY c."id"`,
      { productId },
    );
  }

  openByShop(shopId: string): Promise<CampaignRecord[]> {
    return this.select(
      `SELECT ${COLUMNS} FROM "AdCampaign" c WHERE c."shopId" = :shopId AND c."status" <> 'ENDED' ORDER BY c."id"`,
      { shopId },
    );
  }

  serveCandidates(category: string, limit: number): Promise<ServeCandidate[]> {
    return this.select<ServeCandidate>(
      `SELECT c."id" AS "campaignId", c."shopId", c."productId", c."cpcMinor", c."dailyBudgetMinor",
              p."title", p."priceMinor", p."currency"
         FROM "AdCampaign" c
         JOIN "AdProductSnapshot" p ON p."productId" = c."productId"
         JOIN "AdShopSnapshot" s ON s."shopId" = c."shopId"
        WHERE c."status" = 'ACTIVE'
          AND (:category = 'all' OR c."category" = :category)
          AND p."status" = 'ACTIVE' AND p."inStock" AND NOT p."isSandbox"
          AND s."status" = 'ACTIVE' AND NOT s."offboarding" AND NOT s."deleted"
        ORDER BY c."cpcMinor" DESC, c."id" ASC
        LIMIT :limit`,
      { category, limit },
    );
  }
}
