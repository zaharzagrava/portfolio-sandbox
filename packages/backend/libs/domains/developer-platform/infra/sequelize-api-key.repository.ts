import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  ApiKeyCreated,
  ApiKeyRevoked,
  ApiKeyRotated,
  ApiVersionPinned,
} from '../application/events/api-events';
import { deriveKeyStatus } from '../domain/key-status';
import {
  ApiKeyRecord,
  ApiKeyRepository,
  CreateKeyOutcome,
  NewApiKey,
  RevokeReason,
  RotateKeyOutcome,
} from '../domain/ports';

interface Row {
  id: string;
  shopId: string;
  prefix: string;
  hash: string;
  hashVersion: number;
  name: string;
  scopes: string[];
  livemode: boolean;
  createdBy: string;
  expiresAt: Date | null;
  successorId: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const COLUMNS = `id, "shopId", prefix, hash, "hashVersion", name, scopes, livemode, "createdBy", "expiresAt", "successorId", "rotatedAt", "revokedAt", "lastUsedAt", "createdAt"`;

const toRecord = (r: Row): ApiKeyRecord => ({
  ...r,
  scopes: r.scopes as ApiKeyRecord['scopes'],
});

const isPrefixConflict = (error: unknown): boolean =>
  (error as { name?: string })?.name === 'SequelizeUniqueConstraintError';

/** Aborts a transaction on purpose; the outer call turns it into a typed outcome. */
class Rollback<T> extends Error {
  constructor(readonly outcome: T) {
    super('rollback');
  }
}

/**
 * `ApiKey` in Postgres (R-02). Every transition is a conditional statement with the shop in its predicate; events are
 * appended to the outbox in the same transaction as the change (FR-012). No network call happens inside a transaction.
 */
@Injectable()
export class SequelizeApiKeyRepository extends ApiKeyRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async prefixExists(prefix: string): Promise<boolean> {
    const rows = await this.sequelize.query(
      `SELECT 1 FROM "ApiKey" WHERE prefix = :prefix`,
      { type: QueryTypes.SELECT, replacements: { prefix } },
    );
    return rows.length > 0;
  }

  async createWithLimit(input: {
    key: NewApiKey;
    now: Date;
    limit: number;
    latestVersion: string;
  }): Promise<CreateKeyOutcome> {
    const { key, now, limit, latestVersion } = input;
    try {
      return await this.runner.run(async (tx) => {
        // Pins the shop at its first key and serialises this shop's creators on the settings row until commit.
        const [pin] = await this.sequelize.query<{
          pinnedVersion: string;
          inserted: boolean;
        }>(
          `INSERT INTO "ShopApiSettings" ("shopId", "pinnedVersion", "pinnedAt", "updatedAt")
           VALUES (:shopId, :latestVersion, :now, :now)
           ON CONFLICT ("shopId") DO UPDATE SET "pinnedVersion" = "ShopApiSettings"."pinnedVersion"
           RETURNING "pinnedVersion", (xmax = 0) AS inserted`,
          {
            type: QueryTypes.SELECT,
            transaction: tx,
            replacements: { shopId: key.shopId, latestVersion, now },
          },
        );
        const [{ n }] = await this.sequelize.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "ApiKey"
            WHERE "shopId" = :shopId AND "revokedAt" IS NULL AND "successorId" IS NULL
              AND ("expiresAt" IS NULL OR "expiresAt" > :now)`,
          {
            type: QueryTypes.SELECT,
            transaction: tx,
            replacements: { shopId: key.shopId, now },
          },
        );
        if (n >= limit) return { outcome: 'limit_reached' as const };

        const record = await this.insert(key, now, tx);
        await this.outbox.append(
          [
            ...(pin.inserted
              ? [
                  ApiVersionPinned.create(
                    key.shopId,
                    Math.floor(now.getTime() / 1000),
                    {
                      shopId: key.shopId,
                      version: pin.pinnedVersion,
                      previousVersion: null,
                      actorId: key.createdBy,
                    },
                    now,
                  ),
                ]
              : []),
            ApiKeyCreated.create(
              record.id,
              1,
              {
                keyId: record.id,
                shopId: record.shopId,
                prefix: record.prefix,
                livemode: record.livemode,
                scopes: record.scopes,
                actorId: key.createdBy,
              },
              now,
            ),
          ],
          tx,
        );
        return {
          outcome: 'created' as const,
          record,
          pinnedVersion: pin.pinnedVersion,
        };
      });
    } catch (error) {
      if (isPrefixConflict(error)) return { outcome: 'prefix_taken' };
      throw error;
    }
  }

  async rotate(input: {
    shopId: string;
    keyId: string;
    successor: NewApiKey;
    overlapHours: number;
    now: Date;
    actorId: string;
  }): Promise<RotateKeyOutcome> {
    const { shopId, keyId, successor, overlapHours, now, actorId } = input;
    try {
      return await this.runner.run<RotateKeyOutcome>(async (tx) => {
        // The row lock makes concurrent rotations of one key take turns: the second sees the successor.
        const [current] = await this.sequelize.query<Row>(
          `SELECT ${COLUMNS} FROM "ApiKey" WHERE id = :keyId AND "shopId" = :shopId FOR UPDATE`,
          {
            type: QueryTypes.SELECT,
            transaction: tx,
            replacements: { keyId, shopId },
          },
        );
        if (!current) return { outcome: 'not_found' };
        if (deriveKeyStatus(current, now) !== 'active')
          return { outcome: 'illegal', current: toRecord(current) };

        const created = await this.insert(
          {
            ...successor,
            name: `${current.name} (rotated)`,
            scopes: current.scopes as ApiKeyRecord['scopes'],
            livemode: current.livemode,
            shopId,
          },
          now,
          tx,
        );
        const overlapEnd = new Date(now.getTime() + overlapHours * 3_600_000);
        const [old] = await this.sequelize.query<Row>(
          `UPDATE "ApiKey"
              SET "successorId" = :successorId, "rotatedAt" = :now,
                  "expiresAt" = LEAST(COALESCE("expiresAt", 'infinity'::timestamptz), CAST(:overlapEnd AS timestamptz))
            WHERE id = :keyId AND "shopId" = :shopId AND "revokedAt" IS NULL AND "successorId" IS NULL
              AND ("expiresAt" IS NULL OR "expiresAt" > :now)
            RETURNING ${COLUMNS}`,
          {
            type: QueryTypes.SELECT,
            transaction: tx,
            replacements: {
              successorId: created.id,
              now,
              overlapEnd,
              keyId,
              shopId,
            },
          },
        );
        if (!old) throw new Rollback(current);
        await this.outbox.append(
          ApiKeyRotated.create(
            old.id,
            2,
            {
              keyId: old.id,
              shopId: old.shopId,
              prefix: old.prefix,
              livemode: old.livemode,
              scopes: old.scopes,
              actorId,
              successorId: created.id,
            },
            now,
          ),
          tx,
        );
        return {
          outcome: 'rotated',
          old: toRecord(old),
          successor: created,
        };
      });
    } catch (error) {
      if (error instanceof Rollback)
        return {
          outcome: 'illegal',
          current: toRecord((error as Rollback<Row>).outcome),
        };
      if (isPrefixConflict(error)) return { outcome: 'prefix_taken' };
      throw error;
    }
  }

  async revoke(input: {
    shopId: string;
    keyId: string;
    now: Date;
    actorId: string | null;
    reason: RevokeReason;
  }) {
    const { shopId, keyId, now, actorId, reason } = input;
    return this.runner.run(async (tx) => {
      const [changed] = await this.sequelize.query<Row>(
        `UPDATE "ApiKey" SET "revokedAt" = :now
          WHERE id = :keyId AND "shopId" = :shopId AND "revokedAt" IS NULL
          RETURNING ${COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { keyId, shopId, now },
        },
      );
      if (changed) {
        await this.appendRevoked([changed], now, actorId, reason, tx);
        return { outcome: 'revoked' as const, record: toRecord(changed) };
      }
      const [existing] = await this.sequelize.query<Row>(
        `SELECT ${COLUMNS} FROM "ApiKey" WHERE id = :keyId AND "shopId" = :shopId`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { keyId, shopId },
        },
      );
      return existing
        ? { outcome: 'already_revoked' as const, record: toRecord(existing) }
        : { outcome: 'not_found' as const };
    });
  }

  async revokeAllForShop(
    shopId: string,
    now: Date,
    reason: RevokeReason,
  ): Promise<ApiKeyRecord[]> {
    return this.runner.run(async (tx) => {
      const changed = await this.sequelize.query<Row>(
        `UPDATE "ApiKey" SET "revokedAt" = :now
          WHERE "shopId" = :shopId AND "revokedAt" IS NULL
          RETURNING ${COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { shopId, now },
        },
      );
      await this.appendRevoked(changed, now, null, reason, tx);
      return changed.map(toRecord);
    });
  }

  async findForShop(
    shopId: string,
    keyId: string,
  ): Promise<ApiKeyRecord | null> {
    const [row] = await this.sequelize.query<Row>(
      `SELECT ${COLUMNS} FROM "ApiKey" WHERE id = :keyId AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { keyId, shopId } },
    );
    return row ? toRecord(row) : null;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const [row] = await this.sequelize.query<Row>(
      `SELECT ${COLUMNS} FROM "ApiKey" WHERE prefix = :prefix`,
      { type: QueryTypes.SELECT, replacements: { prefix } },
    );
    return row ? toRecord(row) : null;
  }

  async list(
    shopId: string,
    limit: number,
    after: { createdAt: string; id: string } | null,
  ): Promise<ApiKeyRecord[]> {
    const rows = await this.sequelize.query<Row>(
      `SELECT ${COLUMNS} FROM "ApiKey"
        WHERE "shopId" = :shopId
          AND (CAST(:afterCreatedAt AS timestamptz) IS NULL
               OR ("createdAt", id) < (CAST(:afterCreatedAt AS timestamptz), CAST(:afterId AS uuid)))
        ORDER BY "createdAt" DESC, id DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          limit,
          afterCreatedAt: after?.createdAt ?? null,
          afterId: after?.id ?? null,
        },
      },
    );
    return rows.map(toRecord);
  }

  async touchLastUsed(entries: { id: string; at: Date }[]): Promise<number> {
    if (entries.length === 0) return 0;
    const [, meta] = await this.sequelize.query(
      `UPDATE "ApiKey" k SET "lastUsedAt" = u.at
         FROM (SELECT unnest(CAST(ARRAY[:ids] AS uuid[])) AS id, unnest(CAST(ARRAY[:ats] AS timestamptz[])) AS at) u
        WHERE k.id = u.id AND (k."lastUsedAt" IS NULL OR k."lastUsedAt" < u.at)`,
      {
        replacements: {
          ids: entries.map((e) => e.id),
          ats: entries.map((e) => e.at.toISOString()),
        },
      },
    );
    return (meta as { rowCount?: number })?.rowCount ?? 0;
  }

  async rehash(id: string, hash: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "ApiKey" SET hash = :hash, "hashVersion" = 1 WHERE id = :id AND hash <> :hash`,
      { replacements: { id, hash } },
    );
  }

  private async insert(
    key: NewApiKey,
    now: Date,
    tx: Transaction,
  ): Promise<ApiKeyRecord> {
    const [row] = await this.sequelize.query<Row>(
      `INSERT INTO "ApiKey" (id, "shopId", prefix, hash, "hashVersion", name, scopes, livemode, "createdBy", "expiresAt", "createdAt")
       VALUES (:id, :shopId, :prefix, :hash, 1, :name, CAST(ARRAY[:scopes] AS text[]), :livemode, :createdBy, :expiresAt, :now)
       RETURNING ${COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        transaction: tx,
        replacements: {
          id: uuidv7(),
          shopId: key.shopId,
          prefix: key.prefix,
          hash: key.hash,
          name: key.name,
          scopes: key.scopes,
          livemode: key.livemode,
          createdBy: key.createdBy,
          expiresAt: key.expiresAt,
          now,
        },
      },
    );
    return toRecord(row);
  }

  private async appendRevoked(
    rows: Row[],
    now: Date,
    actorId: string | null,
    reason: RevokeReason,
    tx: Transaction,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.outbox.append(
      rows.map((r) =>
        ApiKeyRevoked.create(
          r.id,
          3,
          {
            keyId: r.id,
            shopId: r.shopId,
            prefix: r.prefix,
            livemode: r.livemode,
            scopes: r.scopes,
            ...(actorId ? { actorId } : {}),
            reason,
          },
          now,
        ),
      ),
      tx,
    );
  }
}
