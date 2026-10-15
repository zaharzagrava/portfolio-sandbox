import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import type { EndpointStatus } from '../domain/endpoint-status';
import {
  ConditionalOutcome,
  EndpointCursor,
  EndpointPatch,
  EndpointRecord,
  EndpointRepository,
  InsertEndpointOutcome,
  NewEndpoint,
} from '../domain/webhook-ports';

const COLUMNS = `id, "shopId", url, "urlNormalized", events, "apiVersion", status, "disabledReason", "failingSince",
  "secretSealed", "previousSecretSealed", "previousSecretExpiresAt", "createdAt", "updatedAt"`;

const isUniqueViolation = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'SequelizeUniqueConstraintError';

/**
 * `WebhookEndpoint` and `WebhookShopCounter` in Postgres (S43 R-02, R-03). Every lookup and every write has the shop in
 * its predicate; every transition is a conditional statement. Methods join the ambient transaction (CLS), so the service
 * writes the endpoint, its history row and its outbox event atomically. No network call happens in here.
 */
@Injectable()
export class SequelizeWebhookEndpointRepository extends EndpointRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
  ) {
    super();
  }

  private select(
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<EndpointRecord[]> {
    return this.sequelize.query<EndpointRecord>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  async insertWithinLimit(
    input: NewEndpoint,
    limit: number,
  ): Promise<InsertEndpointOutcome> {
    return this.runner.run(async () => {
      const inserted = await this.select(
        `INSERT INTO "WebhookEndpoint"
           (id, "shopId", url, "urlNormalized", events, "apiVersion", status, "secretSealed", "createdAt", "updatedAt")
         VALUES (:id, :shopId, :url, :urlNormalized, CAST(:events AS text[]), :apiVersion, 'enabled', :secretSealed, :now, :now)
         ON CONFLICT ("shopId", "urlNormalized") DO NOTHING
         RETURNING ${COLUMNS}`,
        { ...input, events: toPgArray(input.events) },
      );
      if (inserted.length === 0) return { outcome: 'duplicate_url' as const };
      const counted = await this.sequelize.query(
        `INSERT INTO "WebhookShopCounter" ("shopId", "endpoints") VALUES (:shopId, 1)
         ON CONFLICT ("shopId") DO UPDATE SET "endpoints" = "WebhookShopCounter"."endpoints" + 1
           WHERE "WebhookShopCounter"."endpoints" < :limit
         RETURNING "endpoints"`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId: input.shopId, limit },
        },
      );
      if (counted.length === 0) {
        // The slot is taken: undo the insert inside the same transaction, the counter was not touched.
        await this.sequelize.query(
          `DELETE FROM "WebhookEndpoint" WHERE id = :id`,
          {
            replacements: { id: input.id },
          },
        );
        return { outcome: 'limit_reached' as const };
      }
      return { outcome: 'created' as const, endpoint: inserted[0] };
    });
  }

  async findById(shopId: string, id: string): Promise<EndpointRecord | null> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "WebhookEndpoint" WHERE id = :id AND "shopId" = :shopId`,
      { id, shopId },
    );
    return rows[0] ?? null;
  }

  async findForDelivery(id: string): Promise<EndpointRecord | null> {
    const rows = await this.select(
      `SELECT ${COLUMNS} FROM "WebhookEndpoint" WHERE id = :id`,
      { id },
    );
    return rows[0] ?? null;
  }

  listPage(
    shopId: string,
    page: { limit: number; after?: EndpointCursor },
  ): Promise<EndpointRecord[]> {
    const after = page.after;
    return this.select(
      `SELECT ${COLUMNS} FROM "WebhookEndpoint"
        WHERE "shopId" = :shopId
          ${after ? `AND ("createdAt", id) < (CAST(:afterCreatedAt AS timestamptz), CAST(:afterId AS uuid))` : ''}
        ORDER BY "createdAt" DESC, id DESC
        LIMIT :limit`,
      {
        shopId,
        limit: page.limit + 1,
        afterCreatedAt: after?.createdAt.toISOString(),
        afterId: after?.id,
      },
    );
  }

  listEnabledForShop(shopId: string): Promise<EndpointRecord[]> {
    return this.select(
      `SELECT ${COLUMNS} FROM "WebhookEndpoint" WHERE "shopId" = :shopId AND status = 'enabled' ORDER BY "createdAt", id`,
      { shopId },
    );
  }

  async update(shopId: string, id: string, patch: EndpointPatch, now: Date) {
    return this.runner.run(async () => {
      const [before] = await this.select(
        `SELECT ${COLUMNS} FROM "WebhookEndpoint" WHERE id = :id AND "shopId" = :shopId FOR UPDATE`,
        { id, shopId },
      );
      if (!before) return { outcome: 'not_found' as const };
      if (
        patch.urlNormalized !== undefined &&
        patch.urlNormalized !== before.urlNormalized
      ) {
        const taken = await this.sequelize.query(
          `SELECT 1 FROM "WebhookEndpoint" WHERE "shopId" = :shopId AND "urlNormalized" = :urlNormalized AND id <> :id`,
          {
            type: QueryTypes.SELECT,
            replacements: { shopId, urlNormalized: patch.urlNormalized, id },
          },
        );
        if (taken.length > 0) return { outcome: 'duplicate_url' as const };
      }
      try {
        const [after] = await this.select(
          `UPDATE "WebhookEndpoint"
              SET url = COALESCE(:url, url),
                  "urlNormalized" = COALESCE(:urlNormalized, "urlNormalized"),
                  events = COALESCE(CAST(:events AS text[]), events),
                  "apiVersion" = COALESCE(:apiVersion, "apiVersion"),
                  "updatedAt" = :now
            WHERE id = :id AND "shopId" = :shopId
            RETURNING ${COLUMNS}`,
          {
            id,
            shopId,
            now,
            url: patch.url ?? null,
            urlNormalized: patch.urlNormalized ?? null,
            events: patch.events ? toPgArray(patch.events) : null,
            apiVersion: patch.apiVersion ?? null,
          },
        );
        return { outcome: 'applied' as const, endpoint: after, before };
      } catch (error) {
        if (isUniqueViolation(error))
          return { outcome: 'duplicate_url' as const };
        throw error;
      }
    });
  }

  private async outcomeOf(
    shopId: string,
    id: string,
    updated: EndpointRecord[],
  ): Promise<ConditionalOutcome> {
    if (updated.length > 0) return { outcome: 'applied', endpoint: updated[0] };
    const current = await this.findById(shopId, id);
    return current
      ? { outcome: 'conflict', current }
      : { outcome: 'not_found' };
  }

  async transition(
    shopId: string,
    id: string,
    from: EndpointStatus,
    to: { status: EndpointStatus; disabledReason: string | null },
    now: Date,
  ): Promise<ConditionalOutcome> {
    const rows = await this.select(
      `UPDATE "WebhookEndpoint"
          SET status = :toStatus, "disabledReason" = :reason,
              "failingSince" = CASE WHEN :toStatus = 'enabled' THEN NULL ELSE "failingSince" END,
              "updatedAt" = :now
        WHERE id = :id AND "shopId" = :shopId AND status = :from
        RETURNING ${COLUMNS}`,
      { id, shopId, from, toStatus: to.status, reason: to.disabledReason, now },
    );
    return this.outcomeOf(shopId, id, rows);
  }

  async delete(shopId: string, id: string): Promise<EndpointRecord | null> {
    return this.runner.run(async () => {
      const rows = await this.select(
        `DELETE FROM "WebhookEndpoint" WHERE id = :id AND "shopId" = :shopId RETURNING ${COLUMNS}`,
        { id, shopId },
      );
      if (rows.length === 0) return null;
      await this.sequelize.query(
        `UPDATE "WebhookShopCounter" SET "endpoints" = GREATEST("endpoints" - 1, 0) WHERE "shopId" = :shopId`,
        { replacements: { shopId } },
      );
      return rows[0];
    });
  }

  async rotateSecret(
    shopId: string,
    id: string,
    next: { secretSealed: string; previousExpiresAt: Date },
    now: Date,
  ): Promise<ConditionalOutcome> {
    const rows = await this.select(
      `UPDATE "WebhookEndpoint"
          SET "previousSecretSealed" = "secretSealed", "secretSealed" = :secretSealed,
              "previousSecretExpiresAt" = :previousExpiresAt, "updatedAt" = :now
        WHERE id = :id AND "shopId" = :shopId
          AND ("previousSecretSealed" IS NULL OR "previousSecretExpiresAt" IS NULL OR "previousSecretExpiresAt" <= :now)
        RETURNING ${COLUMNS}`,
      { id, shopId, now, ...next },
    );
    return this.outcomeOf(shopId, id, rows);
  }

  async expirePreviousSecret(
    shopId: string,
    id: string,
    now: Date,
  ): Promise<ConditionalOutcome> {
    const rows = await this.select(
      `UPDATE "WebhookEndpoint"
          SET "previousSecretSealed" = NULL, "previousSecretExpiresAt" = NULL, "updatedAt" = :now
        WHERE id = :id AND "shopId" = :shopId
          AND "previousSecretSealed" IS NOT NULL AND "previousSecretExpiresAt" > :now
        RETURNING ${COLUMNS}`,
      { id, shopId, now },
    );
    return this.outcomeOf(shopId, id, rows);
  }

  async markFailing(id: string, at: Date): Promise<Date | null> {
    const set = await this.sequelize.query<{ failingSince: Date }>(
      `UPDATE "WebhookEndpoint" SET "failingSince" = :at WHERE id = :id AND "failingSince" IS NULL RETURNING "failingSince"`,
      { type: QueryTypes.SELECT, replacements: { id, at } },
    );
    if (set.length > 0) return set[0].failingSince;
    const current = await this.sequelize.query<{ failingSince: Date | null }>(
      `SELECT "failingSince" FROM "WebhookEndpoint" WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return current[0]?.failingSince ?? null;
  }

  async markHealthy(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "WebhookEndpoint" SET "failingSince" = NULL WHERE id = :id AND "failingSince" IS NOT NULL`,
      { replacements: { id } },
    );
  }

  async disableIfFailingSince(
    id: string,
    cutoff: Date,
    now: Date,
  ): Promise<EndpointRecord | null> {
    const rows = await this.select(
      `UPDATE "WebhookEndpoint"
          SET status = 'disabled', "disabledReason" = 'auto_failing', "updatedAt" = :now
        WHERE id = :id AND status = 'enabled' AND "failingSince" IS NOT NULL AND "failingSince" <= :cutoff
        RETURNING ${COLUMNS}`,
      { id, cutoff, now },
    );
    return rows[0] ?? null;
  }

  findFailingBefore(
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; shopId: string }[]> {
    return this.sequelize.query<{ id: string; shopId: string }>(
      `SELECT id, "shopId" FROM "WebhookEndpoint"
        WHERE status = 'enabled' AND "failingSince" IS NOT NULL AND "failingSince" <= :cutoff
        ORDER BY "failingSince" LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { cutoff, limit } },
    );
  }

  async deleteForShop(shopId: string, limit: number): Promise<string[]> {
    return this.runner.run(async () => {
      const removed = await this.sequelize.query<{ id: string }>(
        `WITH doomed AS (
           SELECT id FROM "WebhookEndpoint" WHERE "shopId" = :shopId ORDER BY id LIMIT :limit FOR UPDATE SKIP LOCKED
         )
         DELETE FROM "WebhookEndpoint" e USING doomed WHERE e.id = doomed.id RETURNING e.id`,
        { type: QueryTypes.SELECT, replacements: { shopId, limit } },
      );
      if (removed.length < limit)
        await this.sequelize.query(
          `DELETE FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
          { replacements: { shopId } },
        );
      else
        await this.sequelize.query(
          `UPDATE "WebhookShopCounter" SET "endpoints" = GREATEST("endpoints" - :n, 0) WHERE "shopId" = :shopId`,
          { replacements: { shopId, n: removed.length } },
        );
      return removed.map((r) => r.id);
    });
  }
}

/** `{a,b}` literal for a text[] bind (event types contain only letters, dots and underscores). */
const toPgArray = (values: readonly string[]): string =>
  `{${values.join(',')}}`;
