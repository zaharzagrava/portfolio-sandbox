import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { assertActiveTransaction } from '@app/infrastructure/context';
import type {
  LinkRecord,
  LinkRepository,
  LinkState,
  UpsertAppliedInput,
} from '../../domain/ports';
import {
  count,
  json,
  one,
  rows,
  toDate,
  toDateRequired,
  toNumberOrNull,
} from './sql';

const ENTITY = 'product';
const COLUMNS = `"integrationId", "entity", "externalId", "localId", "shopId", "state", "contentDigest", "syncedStock",
  "remoteUpdatedAt", "lastStockWriteAt", "lastLocalVersion", "raw", "updatedAt"`;

function toLink(r: Record<string, unknown>): LinkRecord {
  return {
    integrationId: r.integrationId as string,
    entity: r.entity as string,
    externalId: r.externalId as string,
    localId: r.localId as string,
    shopId: (r.shopId ?? null) as string | null,
    state: r.state as LinkState,
    contentDigest: (r.contentDigest ?? null) as string | null,
    syncedStock: toNumberOrNull(r.syncedStock),
    remoteUpdatedAt: toDate(r.remoteUpdatedAt),
    lastStockWriteAt: toDate(r.lastStockWriteAt),
    lastLocalVersion: toNumberOrNull(r.lastLocalVersion),
    raw: r.raw,
    updatedAt: toDateRequired(r.updatedAt),
  };
}

/** `ExternalLink` (own table). */
@Injectable()
export class SequelizeLinkRepository implements LinkRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async findMany(
    integrationId: string,
    externalIds: string[],
    entity = ENTITY,
  ): Promise<Map<string, LinkRecord>> {
    if (externalIds.length === 0) return new Map();
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ExternalLink"
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "externalId" IN (:externalIds)`,
      { integrationId, entity, externalIds },
    );
    return new Map(found.map((r) => [r.externalId as string, toLink(r)]));
  }

  async findByProduct(
    integrationId: string,
    providerProductId: string,
    entity = ENTITY,
  ): Promise<LinkRecord[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ExternalLink"
        WHERE "integrationId" = :integrationId AND "entity" = :entity
          AND ("externalId" = :providerProductId OR starts_with("externalId", :prefix))
        ORDER BY "externalId"`,
      {
        integrationId,
        entity,
        providerProductId,
        prefix: `${providerProductId}:`,
      },
    );
    return found.map(toLink);
  }

  async getForUpdate(
    integrationId: string,
    externalId: string,
    entity = ENTITY,
  ): Promise<LinkRecord | null> {
    assertActiveTransaction();
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ExternalLink"
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "externalId" = :externalId FOR UPDATE`,
      { integrationId, entity, externalId },
    );
    return r && toLink(r);
  }

  async lockApply(
    integrationId: string,
    externalIds: string[],
    entity = ENTITY,
  ): Promise<void> {
    assertActiveTransaction();
    for (const externalId of [...new Set(externalIds)].sort())
      await rows(
        this.db,
        `SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))`,
        {
          key: `link-apply:${integrationId}:${entity}:${externalId}`,
        },
      );
  }

  async upsertApplied(i: UpsertAppliedInput): Promise<void> {
    // IGNORED (the local product was deleted) is terminal: the conflict update does not apply to such a link.
    await rows(
      this.db,
      `INSERT INTO "ExternalLink" ("integrationId", "entity", "externalId", "localId", "shopId", "state", "contentDigest",
                                   "syncedStock", "remoteUpdatedAt", "lastLocalVersion", "raw", "updatedAt")
       VALUES (:integrationId, :entity, :externalId, :localId, :shopId, 'ACTIVE', :contentDigest,
               :syncedStock, :remoteUpdatedAt, :lastLocalVersion, CAST(:raw AS jsonb), now())
       ON CONFLICT ("integrationId", "entity", "externalId") DO UPDATE SET
         "localId" = EXCLUDED."localId",
         "shopId" = EXCLUDED."shopId",
         "state" = 'ACTIVE',
         "contentDigest" = EXCLUDED."contentDigest",
         "syncedStock" = COALESCE(EXCLUDED."syncedStock", "ExternalLink"."syncedStock"),
         "remoteUpdatedAt" = EXCLUDED."remoteUpdatedAt",
         "lastLocalVersion" = COALESCE(EXCLUDED."lastLocalVersion", "ExternalLink"."lastLocalVersion"),
         "raw" = EXCLUDED."raw",
         "updatedAt" = now()
       WHERE "ExternalLink"."state" <> 'IGNORED'
       RETURNING 1`,
      {
        integrationId: i.integrationId,
        entity: i.entity ?? ENTITY,
        externalId: i.externalId,
        localId: i.localId,
        shopId: i.shopId,
        contentDigest: i.contentDigest,
        syncedStock: i.syncedStock,
        remoteUpdatedAt: i.remoteUpdatedAt,
        lastLocalVersion: i.lastLocalVersion ?? null,
        raw: json(i.raw),
      },
    );
  }

  async markState(
    integrationId: string,
    externalId: string,
    state: LinkState,
    from?: LinkState,
    entity = ENTITY,
  ): Promise<boolean> {
    // IGNORED is terminal: nothing moves a link out of it.
    return (
      (await count(
        this.db,
        `UPDATE "ExternalLink" SET "state" = :state, "updatedAt" = now()
          WHERE "integrationId" = :integrationId AND "entity" = :entity AND "externalId" = :externalId
            AND "state" <> 'IGNORED' AND "state" <> :state ${from ? `AND "state" = :from` : ''}
          RETURNING 1`,
        { integrationId, entity, externalId, state, from },
      )) > 0
    );
  }

  async recordStock(
    integrationId: string,
    externalId: string,
    values: {
      syncedStock: number;
      lastStockWriteAt: Date;
      lastLocalVersion?: number | null;
    },
    entity = ENTITY,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "ExternalLink" SET "syncedStock" = :syncedStock, "lastStockWriteAt" = :at,
                "lastLocalVersion" = COALESCE(:version, "lastLocalVersion"), "updatedAt" = now()
          WHERE "integrationId" = :integrationId AND "entity" = :entity AND "externalId" = :externalId
          RETURNING 1`,
        {
          integrationId,
          entity,
          externalId,
          syncedStock: values.syncedStock,
          at: values.lastStockWriteAt,
          version: values.lastLocalVersion ?? null,
        },
      )) > 0
    );
  }

  async findByLocal(shopId: string, productId: string): Promise<LinkRecord[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ExternalLink" WHERE "shopId" = :shopId AND "localId" = :productId
        ORDER BY "integrationId", "externalId"`,
      { shopId, productId },
    );
    return found.map(toLink);
  }

  ignoreByLocal(shopId: string, productId: string): Promise<number> {
    return count(
      this.db,
      `UPDATE "ExternalLink" SET "state" = 'IGNORED', "updatedAt" = now()
        WHERE "shopId" = :shopId AND "localId" = :productId AND "state" <> 'IGNORED' RETURNING 1`,
      { shopId, productId },
    );
  }

  async pageForReconcile(
    integrationId: string,
    afterExternalId: string | null,
    limit: number,
  ): Promise<LinkRecord[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "ExternalLink"
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "state" <> 'IGNORED'
          ${afterExternalId === null ? '' : `AND "externalId" > :after`}
        ORDER BY "externalId" LIMIT :limit`,
      { integrationId, entity: ENTITY, after: afterExternalId, limit },
    );
    return found.map(toLink);
  }

  async countLinked(integrationId: string): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "ExternalLink"
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "state" <> 'IGNORED'`,
      { integrationId, entity: ENTITY },
    );
    return Number(r?.n ?? 0);
  }
}
