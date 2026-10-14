import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { WidgetSiteChanged } from '../application/events/widget-events';
import { overlapExpiry } from '../domain/site-rules';
import type { WidgetThemeValues } from '../domain/theme';
import {
  CreateSiteOutcome,
  ExpireOutcome,
  HistoryItem,
  KillOutcome,
  NewWidgetSite,
  RotateOutcome,
  ShopCopyUpdate,
  SitePatch,
  UpdateSiteOutcome,
  WidgetChange,
  WidgetSecrets,
  WidgetSiteRecord,
  WidgetSiteRepository,
  WidgetSiteView,
} from '../domain/widget-ports';

const RECORD = `id, "shopId", name, "publishableKey", "allowedOrigins", "featuredProductIds", theme, "killSwitch",
  "previousSecretExpiresAt", ("previousIdentitySecretSealed" IS NOT NULL) AS "hasPreviousSecret", version,
  "shopName", "shopStatus", "shopVersion"::double precision AS "shopVersion", "createdAt", "updatedAt"`;

const VIEW = `id, "shopId", "publishableKey", "allowedOrigins", "featuredProductIds", theme, "killSwitch", version,
  "shopName", "shopStatus", "shopVersion"::double precision AS "shopVersion"`;

/** A Postgres array literal; every element is quoted, so no element can end the literal. */
const pgArray = (items: readonly string[]): string =>
  `{${items.map((i) => `"${i.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  new Set(a).size === new Set(b).size && a.every((v) => b.includes(v));
const sameTheme = (a: WidgetThemeValues, b: WidgetThemeValues): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return (
    sameList(ka, kb) &&
    ka.every(
      (k) =>
        (a as Record<string, string>)[k] === (b as Record<string, string>)[k],
    )
  );
};

const isUniqueViolation = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'SequelizeUniqueConstraintError';

/**
 * `WidgetSite` and `WidgetSiteChange` in Postgres. Every lookup carries the shop in its predicate (an id of another shop
 * is an unknown id); every change is one transaction holding the change, its history row and its outbox event, and no
 * network call happens inside it (FR-037, AS-51).
 */
@Injectable()
export class SequelizeWidgetSiteRepository extends WidgetSiteRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown>,
    transaction?: Transaction,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
      transaction,
    });
  }

  private async emit(
    tx: Transaction,
    site: { id: string; shopId: string; version: number },
    changes: WidgetChange[],
    now: Date,
    actorId: string | undefined,
  ): Promise<void> {
    await this.outbox.append(
      changes.map((change) =>
        WidgetSiteChanged.create(
          site.id,
          site.version,
          {
            siteId: site.id,
            shopId: site.shopId,
            change,
            ...(actorId ? { actorId } : {}),
          },
          now,
        ),
      ),
      tx,
    );
  }

  async createWithLimit(input: {
    site: NewWidgetSite;
    limit: number;
    now: Date;
    actorId: string;
  }): Promise<CreateSiteOutcome> {
    const { site, limit, now, actorId } = input;
    try {
      return await this.runner.run<CreateSiteOutcome>(async (tx) => {
        // Concurrent creators of one shop take turns: the count below cannot be stale when the insert runs.
        await this.sequelize.query(
          `SELECT pg_advisory_xact_lock(hashtext(:shopId))`,
          { transaction: tx, replacements: { shopId: site.shopId } },
        );
        const [{ n }] = await this.select<{ n: number }>(
          `SELECT count(*)::int AS n FROM "WidgetSite" WHERE "shopId" = :shopId`,
          { shopId: site.shopId },
          tx,
        );
        if (n >= limit) return { outcome: 'limit_reached' };
        const [row] = await this.select<WidgetSiteRecord>(
          `INSERT INTO "WidgetSite"
             (id, "shopId", name, "publishableKey", "allowedOrigins", "featuredProductIds", "identitySecretSealed",
              "shopName", "shopStatus", "shopVersion", "createdAt", "updatedAt")
           VALUES (:id, :shopId, :name, :publishableKey, CAST(:origins AS text[]), CAST(:featured AS uuid[]), :sealed,
                   :shopName, :shopStatus, :shopVersion, :now, :now)
           RETURNING ${RECORD}`,
          {
            id: site.id,
            shopId: site.shopId,
            name: site.name,
            publishableKey: site.publishableKey,
            origins: pgArray(site.allowedOrigins),
            featured: pgArray(site.featuredProductIds),
            sealed: site.identitySecretSealed,
            shopName: site.shopName,
            shopStatus: site.shopStatus,
            shopVersion: site.shopVersion,
            now,
          },
          tx,
        );
        await this.emit(tx, row, ['created'], now, actorId);
        return { outcome: 'created', site: row };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: 'key_taken' };
      throw error;
    }
  }

  async findForShop(
    shopId: string,
    siteId: string,
  ): Promise<WidgetSiteRecord | null> {
    const [row] = await this.select<WidgetSiteRecord>(
      `SELECT ${RECORD} FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId`,
      { siteId, shopId },
    );
    return row ?? null;
  }

  async findViewByKey(key: string): Promise<WidgetSiteView | null> {
    const [row] = await this.select<WidgetSiteView>(
      `SELECT ${VIEW} FROM "WidgetSite" WHERE "publishableKey" = :key`,
      { key },
    );
    return row ?? null;
  }

  async findViewById(siteId: string): Promise<WidgetSiteView | null> {
    const [row] = await this.select<WidgetSiteView>(
      `SELECT ${VIEW} FROM "WidgetSite" WHERE id = :siteId`,
      { siteId },
    );
    return row ?? null;
  }

  async secretsOf(siteId: string): Promise<WidgetSecrets | null> {
    const [row] = await this.select<{
      current: string;
      previous: string | null;
      previousExpiresAt: Date | null;
    }>(
      `SELECT "identitySecretSealed" AS current, "previousIdentitySecretSealed" AS previous,
              "previousSecretExpiresAt" AS "previousExpiresAt"
         FROM "WidgetSite" WHERE id = :siteId`,
      { siteId },
    );
    return row ?? null;
  }

  async list(
    shopId: string,
    page: { limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<WidgetSiteRecord[]> {
    return this.select<WidgetSiteRecord>(
      `SELECT ${RECORD} FROM "WidgetSite"
        WHERE "shopId" = :shopId
          AND (CAST(:afterId AS uuid) IS NULL
               OR (date_trunc('milliseconds', "createdAt"), id) < (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY date_trunc('milliseconds', "createdAt") DESC, id DESC
        LIMIT :limit`,
      {
        shopId,
        limit: page.limit,
        afterId: page.after?.id ?? null,
        afterAt: page.after?.createdAt ?? null,
      },
    );
  }

  async update(input: {
    shopId: string;
    siteId: string;
    expectedVersion: number;
    patch: SitePatch;
    now: Date;
    actorId: string;
  }): Promise<UpdateSiteOutcome> {
    const { shopId, siteId, expectedVersion, patch, now, actorId } = input;
    return this.runner.run<UpdateSiteOutcome>(async (tx) => {
      const [current] = await this.select<WidgetSiteRecord>(
        `SELECT ${RECORD} FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId FOR UPDATE`,
        { siteId, shopId },
        tx,
      );
      if (!current) return { outcome: 'not_found' };
      if (current.version !== expectedVersion) return { outcome: 'conflict' };

      const changes: WidgetChange[] = [];
      const next = { ...current };
      let anything = false;
      if (patch.name !== undefined && patch.name !== current.name) {
        next.name = patch.name;
        anything = true;
      }
      if (
        patch.allowedOrigins !== undefined &&
        !sameSet(patch.allowedOrigins, current.allowedOrigins)
      ) {
        next.allowedOrigins = patch.allowedOrigins;
        changes.push('origins_changed');
        anything = true;
      }
      if (
        patch.featuredProductIds !== undefined &&
        !sameList(patch.featuredProductIds, current.featuredProductIds)
      ) {
        next.featuredProductIds = patch.featuredProductIds;
        changes.push('products_changed');
        anything = true;
      }
      if (patch.theme !== undefined && !sameTheme(patch.theme, current.theme)) {
        next.theme = patch.theme;
        changes.push('theme_changed');
        anything = true;
      }
      if (!anything) return { outcome: 'updated', site: current, changes: [] };

      const [row] = await this.select<WidgetSiteRecord>(
        `UPDATE "WidgetSite"
            SET name = :name, "allowedOrigins" = CAST(:origins AS text[]),
                "featuredProductIds" = CAST(:featured AS uuid[]), theme = CAST(:theme AS jsonb),
                version = version + 1, "updatedAt" = :now
          WHERE id = :siteId AND "shopId" = :shopId
          RETURNING ${RECORD}`,
        {
          siteId,
          shopId,
          name: next.name,
          origins: pgArray(next.allowedOrigins),
          featured: pgArray(next.featuredProductIds),
          theme: JSON.stringify(next.theme),
          now,
        },
        tx,
      );
      await this.emit(tx, row, changes, now, actorId);
      return { outcome: 'updated', site: row, changes };
    });
  }

  async rotateSecret(input: {
    shopId: string;
    siteId: string;
    newSealed: string;
    overlapHours: number;
    now: Date;
    actorId: string;
  }): Promise<RotateOutcome> {
    const { shopId, siteId, newSealed, overlapHours, now, actorId } = input;
    return this.runner.run<RotateOutcome>(async (tx) => {
      // The row is only taken when no previous secret is still valid; a second rotation finds none and refuses.
      const [row] = await this.select<WidgetSiteRecord>(
        `UPDATE "WidgetSite"
            SET "previousIdentitySecretSealed" = CASE WHEN :keep THEN "identitySecretSealed" END,
                "previousSecretExpiresAt" = CASE WHEN :keep THEN CAST(:expires AS timestamptz) END,
                "identitySecretSealed" = :newSealed, "updatedAt" = :now
          WHERE id = :siteId AND "shopId" = :shopId
            AND ("previousIdentitySecretSealed" IS NULL OR "previousSecretExpiresAt" <= :now)
          RETURNING ${RECORD}`,
        {
          siteId,
          shopId,
          newSealed,
          now,
          keep: overlapHours > 0,
          expires: overlapExpiry(now, overlapHours),
        },
        tx,
      );
      if (!row) {
        const exists = await this.select(
          `SELECT 1 FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId`,
          { siteId, shopId },
          tx,
        );
        return exists.length
          ? { outcome: 'in_progress' }
          : { outcome: 'not_found' };
      }
      await this.emit(tx, row, ['secret_rotated'], now, actorId);
      return { outcome: 'rotated', site: row };
    });
  }

  async expirePreviousSecret(input: {
    shopId: string;
    siteId: string;
    now: Date;
    actorId: string;
  }): Promise<ExpireOutcome> {
    const { shopId, siteId, now, actorId } = input;
    return this.runner.run<ExpireOutcome>(async (tx) => {
      const [row] = await this.select<WidgetSiteRecord>(
        `UPDATE "WidgetSite"
            SET "previousIdentitySecretSealed" = NULL, "previousSecretExpiresAt" = NULL, "updatedAt" = :now
          WHERE id = :siteId AND "shopId" = :shopId AND "previousIdentitySecretSealed" IS NOT NULL
          RETURNING ${RECORD}`,
        { siteId, shopId, now },
        tx,
      );
      if (!row) {
        const exists = await this.select(
          `SELECT 1 FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId`,
          { siteId, shopId },
          tx,
        );
        return exists.length
          ? { outcome: 'not_in_progress' }
          : { outcome: 'not_found' };
      }
      await this.emit(tx, row, ['previous_secret_expired'], now, actorId);
      return { outcome: 'expired', site: row };
    });
  }

  async setKillSwitch(input: {
    shopId: string;
    siteId: string;
    on: boolean;
    now: Date;
    actorId: string;
  }): Promise<KillOutcome> {
    const { shopId, siteId, on, now, actorId } = input;
    return this.runner.run<KillOutcome>(async (tx) => {
      // Conditional on the value: of any number of concurrent flips to the same state exactly one changes the row.
      const [row] = await this.select<WidgetSiteRecord>(
        `UPDATE "WidgetSite"
            SET "killSwitch" = :on, version = version + 1, "updatedAt" = :now
          WHERE id = :siteId AND "shopId" = :shopId AND "killSwitch" <> :on
          RETURNING ${RECORD}`,
        { siteId, shopId, on, now },
        tx,
      );
      if (!row) {
        const [current] = await this.select<WidgetSiteRecord>(
          `SELECT ${RECORD} FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId`,
          { siteId, shopId },
          tx,
        );
        return current
          ? { outcome: 'unchanged', site: current }
          : { outcome: 'not_found' };
      }
      const change: WidgetChange = on ? 'kill_switch_on' : 'kill_switch_off';
      await this.sequelize.query(
        `INSERT INTO "WidgetSiteChange" ("siteId", "shopId", change, "fromValue", "toValue", "actorId", "at")
         VALUES (:siteId, :shopId, :change, :from, :to, :actorId, :now)`,
        {
          transaction: tx,
          replacements: {
            siteId,
            shopId,
            change,
            from: String(!on),
            to: String(on),
            actorId,
            now,
          },
        },
      );
      await this.emit(tx, row, [change], now, actorId);
      return { outcome: 'changed', site: row };
    });
  }

  async delete(input: {
    shopId: string;
    siteId: string;
    now: Date;
    actorId: string;
  }): Promise<
    { outcome: 'deleted'; publishableKey: string } | { outcome: 'not_found' }
  > {
    const { shopId, siteId, now, actorId } = input;
    return this.runner.run(async (tx) => {
      const [row] = await this.select<{
        id: string;
        shopId: string;
        publishableKey: string;
        version: number;
      }>(
        `DELETE FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId
         RETURNING id, "shopId", "publishableKey", version`,
        { siteId, shopId },
        tx,
      );
      if (!row) return { outcome: 'not_found' as const };
      await this.emit(
        tx,
        { ...row, version: row.version + 1 },
        ['deleted'],
        now,
        actorId,
      );
      return {
        outcome: 'deleted' as const,
        publishableKey: row.publishableKey,
      };
    });
  }

  async history(
    shopId: string,
    siteId: string,
    page: { limit: number; beforeSeq?: number },
  ): Promise<HistoryItem[] | null> {
    const exists = await this.select(
      `SELECT 1 FROM "WidgetSite" WHERE id = :siteId AND "shopId" = :shopId`,
      { siteId, shopId },
    );
    if (!exists.length) return null;
    return this.select<HistoryItem>(
      `SELECT id, change, "fromValue" AS "from", "toValue" AS "to", "actorId", "at", seq::double precision AS seq
         FROM "WidgetSiteChange"
        WHERE "siteId" = :siteId AND (CAST(:before AS bigint) IS NULL OR seq < CAST(:before AS bigint))
        ORDER BY seq DESC LIMIT :limit`,
      { siteId, limit: page.limit, before: page.beforeSeq ?? null },
    );
  }

  async deleteByShop(
    shopId: string,
    now: Date,
  ): Promise<{ id: string; publishableKey: string }[]> {
    return this.runner.run(async (tx) => {
      const rows = await this.select<{
        id: string;
        publishableKey: string;
        version: number;
      }>(
        `DELETE FROM "WidgetSite" WHERE "shopId" = :shopId RETURNING id, "publishableKey", version`,
        { shopId },
        tx,
      );
      for (const row of rows)
        await this.emit(
          tx,
          { id: row.id, shopId, version: row.version + 1 },
          ['deleted'],
          now,
          undefined,
        );
      return rows.map(({ id, publishableKey }) => ({ id, publishableKey }));
    });
  }

  async applyShopCopy(
    shopId: string,
    update: ShopCopyUpdate,
  ): Promise<string[]> {
    const rows = await this.select<{ publishableKey: string }>(
      `UPDATE "WidgetSite"
          SET "shopName" = COALESCE(CAST(:name AS text), "shopName"),
              "shopStatus" = COALESCE(CAST(:status AS text), "shopStatus"),
              "shopVersion" = :shopVersion
        WHERE "shopId" = :shopId AND "shopVersion" < :shopVersion
        RETURNING "publishableKey"`,
      {
        shopId,
        shopVersion: update.shopVersion,
        name: update.name ?? null,
        status: update.status ?? null,
      },
    );
    return rows.map((r) => r.publishableKey);
  }

  backfillPage(afterId: string | null, limit: number) {
    return this.select<{
      id: string;
      shopId: string;
      identitySecretSealed: string;
      shopVersion: number;
    }>(
      `SELECT id, "shopId", "identitySecretSealed", "shopVersion"::double precision AS "shopVersion"
         FROM "WidgetSite" WHERE (CAST(:afterId AS uuid) IS NULL OR id > CAST(:afterId AS uuid))
        ORDER BY id LIMIT :limit`,
      { afterId, limit },
    );
  }

  async resealIf(
    siteId: string,
    expectedSealed: string,
    newSealed: string,
  ): Promise<boolean> {
    const rows = await this.select(
      `UPDATE "WidgetSite" SET "identitySecretSealed" = :newSealed
        WHERE id = :siteId AND "identitySecretSealed" = :expectedSealed RETURNING id`,
      { siteId, expectedSealed, newSealed },
    );
    return rows.length > 0;
  }
}
