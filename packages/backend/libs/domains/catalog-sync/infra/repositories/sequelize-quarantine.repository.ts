import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import type {
  ListPage,
  PageQuery,
  QuarantineInput,
  QuarantineRecord,
  QuarantineRepository,
  QuarantineResolution,
  QuarantineStatus,
} from '../../domain/ports';
import { KeysetCursorCodec, keysetPage } from './keyset-cursor';
import { count, json, one, toDate, toDateRequired } from './sql';

const COLUMNS = `"id", "integrationId", "entity", "externalId", "dedupeKey", "payloadDigest", "reasonCode", "message",
  "payload", "status", "occurrences", "firstSeenAt", "lastSeenAt", "resolution", "dismissedBy", "resolvedAt"`;

function toQuarantine(r: Record<string, unknown>): QuarantineRecord {
  return {
    id: r.id as string,
    integrationId: r.integrationId as string,
    entity: r.entity as string,
    externalId: (r.externalId ?? null) as string | null,
    dedupeKey: (r.dedupeKey ?? r.externalId ?? r.id) as string,
    payloadDigest: (r.payloadDigest ?? null) as string | null,
    reasonCode: (r.reasonCode ?? 'legacy') as string,
    message: (r.message ?? '') as string,
    payload: r.payload ?? null,
    status: r.status as QuarantineStatus,
    occurrences: Number(r.occurrences),
    firstSeenAt: toDateRequired(r.firstSeenAt),
    lastSeenAt: toDateRequired(r.lastSeenAt),
    resolution: (r.resolution ?? null) as QuarantineResolution | null,
    dismissedBy: (r.dismissedBy ?? null) as string | null,
    resolvedAt: toDate(r.resolvedAt),
  };
}

/** `SyncQuarantine` (own table). */
@Injectable()
export class SequelizeQuarantineRepository implements QuarantineRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  async record(i: QuarantineInput, now: Date): Promise<QuarantineRecord> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `INSERT INTO "SyncQuarantine" ("integrationId", "entity", "externalId", "dedupeKey", "payloadDigest", "reasonCode",
                                     "message", "payload", "status", "occurrences", "firstSeenAt", "lastSeenAt")
       VALUES (:integrationId, :entity, :externalId, :dedupeKey, :payloadDigest, :reasonCode,
               left(:message, 500), CAST(:payload AS jsonb), 'OPEN', 1, :now, :now)
       ON CONFLICT ("integrationId", "entity", "dedupeKey") WHERE "status" = 'OPEN' DO UPDATE SET
         "occurrences" = "SyncQuarantine"."occurrences" + 1,
         "lastSeenAt" = :now,
         "reasonCode" = EXCLUDED."reasonCode",
         "message" = EXCLUDED."message",
         "payload" = EXCLUDED."payload",
         "payloadDigest" = EXCLUDED."payloadDigest"
       RETURNING ${COLUMNS}`,
      {
        integrationId: i.integrationId,
        entity: i.entity,
        externalId: i.externalId,
        dedupeKey: i.dedupeKey,
        payloadDigest: i.payloadDigest,
        reasonCode: i.reasonCode,
        message: i.message,
        payload: json(i.payload),
        now,
      },
    );
    return toQuarantine(r as Record<string, unknown>);
  }

  resolveByDedupeKey(
    integrationId: string,
    entity: string,
    dedupeKey: string,
    now: Date,
  ): Promise<number> {
    return count(
      this.db,
      `UPDATE "SyncQuarantine" SET "status" = 'RESOLVED', "resolution" = 'fixed_at_provider', "resolvedAt" = :now
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "dedupeKey" = :dedupeKey
          AND "status" = 'OPEN' RETURNING 1`,
      { integrationId, entity, dedupeKey, now },
    );
  }

  resolveMany(
    integrationId: string,
    entity: string,
    dedupeKeys: string[],
    now: Date,
  ): Promise<number> {
    return count(
      this.db,
      `UPDATE "SyncQuarantine" SET "status" = 'RESOLVED', "resolution" = 'fixed_at_provider', "resolvedAt" = :now
        WHERE "integrationId" = :integrationId AND "entity" = :entity AND "dedupeKey" IN (:dedupeKeys)
          AND "status" = 'OPEN' RETURNING 1`,
      { integrationId, entity, dedupeKeys, now },
    );
  }

  async close(
    integrationId: string,
    id: string,
    to: Exclude<QuarantineStatus, 'OPEN'>,
    resolution: QuarantineResolution,
    actorId: string | null,
    now: Date,
  ): Promise<QuarantineRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "SyncQuarantine" SET "status" = :to, "resolution" = :resolution, "resolvedAt" = :now,
              "dismissedBy" = CASE WHEN :to = 'DISMISSED' THEN CAST(:actorId AS uuid) ELSE NULL END
        WHERE "integrationId" = :integrationId AND "id" = :id AND "status" = 'OPEN'
        RETURNING ${COLUMNS}`,
      { integrationId, id, to, resolution, actorId, now },
    );
    return r && toQuarantine(r);
  }

  async findInIntegration(
    integrationId: string,
    id: string,
  ): Promise<QuarantineRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "SyncQuarantine" WHERE "integrationId" = :integrationId AND "id" = :id`,
      { integrationId, id },
    );
    return r && toQuarantine(r);
  }

  listPage(
    integrationId: string,
    query: PageQuery & { status?: QuarantineStatus },
  ): Promise<ListPage<QuarantineRecord>> {
    return keysetPage({
      db: this.db,
      codec: this.codec,
      table: 'SyncQuarantine',
      tsColumn: 'firstSeenAt',
      where: `t."integrationId" = :integrationId ${query.status ? `AND t."status" = :status` : ''}`,
      replacements: { integrationId, status: query.status },
      scope: `quarantine:${integrationId}:${query.status ?? '*'}`,
      query,
      map: toQuarantine,
    });
  }

  purgeClosedBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "SyncQuarantine" WHERE "id" IN (
         SELECT "id" FROM "SyncQuarantine"
          WHERE "status" IN ('RESOLVED', 'DISMISSED') AND COALESCE("resolvedAt", "lastSeenAt") < :before
          ORDER BY COALESCE("resolvedAt", "lastSeenAt") LIMIT :limit) RETURNING 1`,
      { before, limit },
    );
  }

  expireOpenBefore(before: Date, now: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `UPDATE "SyncQuarantine" SET "status" = 'DISMISSED', "resolution" = 'expired', "resolvedAt" = :now
        WHERE "id" IN (SELECT "id" FROM "SyncQuarantine" WHERE "status" = 'OPEN' AND "firstSeenAt" < :before
                        ORDER BY "firstSeenAt" LIMIT :limit) RETURNING 1`,
      { before, now, limit },
    );
  }

  async countAllOpen(): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "SyncQuarantine" WHERE "status" = 'OPEN'`,
    );
    return Number(r?.n ?? 0);
  }

  async countOpen(integrationId: string): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "SyncQuarantine" WHERE "integrationId" = :integrationId AND "status" = 'OPEN'`,
      { integrationId },
    );
    return Number(r?.n ?? 0);
  }
}
