import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { Transactional } from '@app/infrastructure/context';
import { BREAKER_FAILURES, type BreakerState } from '../../domain/breaker';
import type { IntegrationStatus } from '../../domain/integration-status';
import type { ProviderName } from '../../domain/normalise';
import type {
  InsertConnectedInput,
  InsertConnectedResult,
  IntegrationRecord,
  IntegrationRepository,
  ListPage,
  PageQuery,
  TransitionOptions,
} from '../../domain/ports';
import { KeysetCursorCodec, keysetPage } from './keyset-cursor';
import { count, one, rows, toDate, toDateRequired } from './sql';

const COLUMNS = `"id", "shopId", "provider", "externalShop", "status", "pausedReason", "credentialsSealed", "locationId",
  "connectedBy", "lastError", "lastSyncAt", "consecutiveFailures", "breakerOpenUntil", "nextSyncAt", "createdAt", "updatedAt"`;

export function toIntegration(r: Record<string, unknown>): IntegrationRecord {
  return {
    id: r.id as string,
    shopId: r.shopId as string,
    provider: r.provider as ProviderName,
    externalShop: r.externalShop as string,
    status: r.status as IntegrationStatus,
    pausedReason: (r.pausedReason ?? null) as IntegrationRecord['pausedReason'],
    credentialsSealed: (r.credentialsSealed ?? null) as string | null,
    locationId: (r.locationId ?? null) as string | null,
    connectedBy: (r.connectedBy ?? null) as string | null,
    lastError: (r.lastError ?? null) as string | null,
    lastSyncAt: toDate(r.lastSyncAt),
    consecutiveFailures: Number(r.consecutiveFailures ?? 0),
    breakerOpenUntil: toDate(r.breakerOpenUntil),
    nextSyncAt: toDate(r.nextSyncAt),
    createdAt: toDateRequired(r.createdAt),
    updatedAt: toDateRequired(r.updatedAt),
  };
}

/** `Integration` and `IntegrationHistory` (own tables only). */
@Injectable()
export class SequelizeIntegrationRepository implements IntegrationRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  @Transactional()
  async insertConnected(
    input: InsertConnectedInput,
  ): Promise<InsertConnectedResult> {
    // Serialises concurrent connects of one shop so the per-shop limit cannot be overshot.
    await rows(
      this.db,
      `SELECT pg_advisory_xact_lock(hashtext('integration-limit:' || :shopId))`,
      { shopId: input.shopId },
    );
    if ((await this.countActiveForShop(input.shopId)) >= input.maxPerShop)
      return { kind: 'limit_reached' };
    const inserted = await one<Record<string, unknown>>(
      this.db,
      `INSERT INTO "Integration" ("id", "shopId", "provider", "externalShop", "status", "credentialsSealed", "locationId",
                                  "connectedBy", "nextSyncAt", "createdAt", "updatedAt")
       VALUES (:id, :shopId, :provider, :externalShop, 'ACTIVE', :sealed, :locationId, :connectedBy, :now, :now, :now)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      {
        id: input.id,
        shopId: input.shopId,
        provider: input.provider,
        externalShop: input.externalShop,
        sealed: input.credentialsSealed,
        locationId: input.locationId,
        connectedBy: input.connectedBy,
        now: input.now,
      },
    );
    if (!inserted) return { kind: 'store_already_connected' };
    await this.history(
      input.id,
      null,
      'ACTIVE',
      'connect',
      input.connectedBy,
      input.now,
    );
    return { kind: 'inserted', integration: toIntegration(inserted) };
  }

  @Transactional()
  async transition(
    id: string,
    from: IntegrationStatus,
    to: IntegrationStatus,
    o: TransitionOptions,
  ): Promise<IntegrationRecord | null> {
    const sets = [
      `"status" = :to`,
      `"pausedReason" = :pausedReason`,
      `"updatedAt" = :now`,
    ];
    const replacements: Record<string, unknown> = {
      id,
      from,
      to,
      now: o.now,
      pausedReason: to === 'PAUSED' ? (o.pausedReason ?? null) : null,
    };
    if (to === 'ACTIVE') {
      sets.push(
        `"consecutiveFailures" = 0`,
        `"breakerOpenUntil" = NULL`,
        `"nextSyncAt" = :now`,
        `"lastError" = NULL`,
      );
    } else if (o.lastError !== undefined) {
      sets.push(`"lastError" = :lastError`);
      replacements.lastError = o.lastError;
    }
    if (to === 'DISCONNECTED') sets.push(`"nextSyncAt" = NULL`);
    if (o.eraseCredentials) sets.push(`"credentialsSealed" = NULL`);
    else if (o.credentialsSealed !== undefined) {
      sets.push(`"credentialsSealed" = :sealed`);
      replacements.sealed = o.credentialsSealed;
    }
    if (o.locationId !== undefined) {
      sets.push(`"locationId" = :locationId`);
      replacements.locationId = o.locationId;
    }
    const updated = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "Integration" SET ${sets.join(', ')} WHERE "id" = :id AND "status" = :from RETURNING ${COLUMNS}`,
      replacements,
    );
    if (!updated) return null;
    await this.history(id, from, to, o.reason, o.actorId, o.now);
    return toIntegration(updated);
  }

  private async history(
    integrationId: string,
    from: IntegrationStatus | null,
    to: IntegrationStatus,
    reason: string,
    actorId: string | null,
    at: Date,
  ): Promise<void> {
    await rows(
      this.db,
      `INSERT INTO "IntegrationHistory" ("integrationId", "fromStatus", "toStatus", "reason", "actorId", "at")
       VALUES (:integrationId, :from, :to, :reason, :actorId, :at) RETURNING 1`,
      { integrationId, from, to, reason, actorId, at },
    );
  }

  @Transactional()
  async lockShopLimit(shopId: string): Promise<void> {
    await rows(
      this.db,
      `SELECT pg_advisory_xact_lock(hashtext('integration-limit:' || :shopId))`,
      { shopId },
    );
  }

  async findById(id: string): Promise<IntegrationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "Integration" WHERE "id" = :id`,
      { id },
    );
    return r && toIntegration(r);
  }

  async findInShop(
    shopId: string,
    id: string,
  ): Promise<IntegrationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "Integration" WHERE "shopId" = :shopId AND "id" = :id`,
      { shopId, id },
    );
    return r && toIntegration(r);
  }

  async findByShopAndStore(
    shopId: string,
    provider: ProviderName,
    externalShop: string,
  ): Promise<IntegrationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "Integration"
        WHERE "shopId" = :shopId AND "provider" = :provider AND "externalShop" = :externalShop`,
      { shopId, provider, externalShop },
    );
    return r && toIntegration(r);
  }

  async findLiveByStore(
    provider: ProviderName,
    externalShop: string,
  ): Promise<IntegrationRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "Integration"
        WHERE "provider" = :provider AND "externalShop" = :externalShop AND "status" <> 'DISCONNECTED'`,
      { provider, externalShop },
    );
    return r && toIntegration(r);
  }

  listPage(
    shopId: string,
    query: PageQuery,
  ): Promise<ListPage<IntegrationRecord>> {
    return keysetPage({
      db: this.db,
      codec: this.codec,
      table: 'Integration',
      tsColumn: 'createdAt',
      where: `t."shopId" = :shopId`,
      replacements: { shopId },
      scope: `integrations:${shopId}`,
      query,
      map: toIntegration,
    });
  }

  async listByShop(
    shopId: string,
    statuses: readonly IntegrationStatus[],
  ): Promise<IntegrationRecord[]> {
    if (statuses.length === 0) return [];
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "Integration" WHERE "shopId" = :shopId AND "status" IN (:statuses)
        ORDER BY "createdAt" DESC, "id" DESC`,
      { shopId, statuses: [...statuses] },
    );
    return found.map(toIntegration);
  }

  async countActiveForShop(shopId: string): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "Integration" WHERE "shopId" = :shopId AND "status" <> 'DISCONNECTED'`,
      { shopId },
    );
    return Number(r?.n ?? 0);
  }

  async dueForSync(
    now: Date,
    limit: number,
  ): Promise<
    Array<
      Pick<IntegrationRecord, 'id' | 'shopId' | 'provider' | 'breakerOpenUntil'>
    >
  > {
    const found = await rows<{
      id: string;
      shopId: string;
      provider: ProviderName;
      breakerOpenUntil: unknown;
    }>(
      this.db,
      `SELECT "id", "shopId", "provider", "breakerOpenUntil" FROM "Integration"
        WHERE "status" = 'ACTIVE' AND ("nextSyncAt" IS NULL OR "nextSyncAt" <= :now)
        ORDER BY "nextSyncAt" NULLS FIRST, "id" LIMIT :limit`,
      { now, limit },
    );
    return found.map((r) => ({
      ...r,
      breakerOpenUntil: toDate(r.breakerOpenUntil),
    }));
  }

  async listActive(afterId: string | null, limit: number) {
    const found = await rows<{
      id: string;
      shopId: string;
      provider: ProviderName;
      breakerOpenUntil: unknown;
    }>(
      this.db,
      `SELECT "id", "shopId", "provider", "breakerOpenUntil" FROM "Integration"
        WHERE "status" = 'ACTIVE' ${afterId === null ? '' : `AND "id" > :afterId`}
        ORDER BY "id" LIMIT :limit`,
      { afterId, limit },
    );
    return found.map((r) => ({
      ...r,
      breakerOpenUntil: toDate(r.breakerOpenUntil),
    }));
  }

  async activeWatermarks(afterId: string | null, limit: number) {
    const found = await rows<{
      id: string;
      shopId: string;
      provider: ProviderName;
      watermark: unknown;
    }>(
      this.db,
      `SELECT i."id", i."shopId", i."provider", c."watermark"
         FROM "Integration" i
         JOIN "SyncCursor" c ON c."integrationId" = i."id" AND c."entity" = 'product'
        WHERE i."status" = 'ACTIVE' AND c."watermark" IS NOT NULL
          ${afterId === null ? '' : `AND i."id" > :afterId`}
        ORDER BY i."id" LIMIT :limit`,
      { afterId, limit },
    );
    return found.map((r) => ({ ...r, watermark: toDateRequired(r.watermark) }));
  }

  async countBreakerOpen(now: Date): Promise<Record<string, number>> {
    const found = await rows<{ provider: string; n: string }>(
      this.db,
      `SELECT "provider", count(*) AS n FROM "Integration"
        WHERE "status" <> 'DISCONNECTED' AND "breakerOpenUntil" > :now GROUP BY "provider"`,
      { now },
    );
    return Object.fromEntries(found.map((r) => [r.provider, Number(r.n)]));
  }

  async setNextSync(id: string, at: Date | null): Promise<void> {
    await rows(
      this.db,
      `UPDATE "Integration" SET "nextSyncAt" = :at WHERE "id" = :id RETURNING 1`,
      { id, at },
    );
  }

  async recordSynced(
    id: string,
    at: Date,
    nextSyncAt: Date | null,
  ): Promise<void> {
    await rows(
      this.db,
      `UPDATE "Integration" SET "lastSyncAt" = :at, "nextSyncAt" = :nextSyncAt, "lastError" = NULL, "updatedAt" = :at
        WHERE "id" = :id RETURNING 1`,
      { id, at, nextSyncAt },
    );
  }

  async recordError(id: string, message: string): Promise<void> {
    await rows(
      this.db,
      `UPDATE "Integration" SET "lastError" = left(:message, 500), "updatedAt" = now() WHERE "id" = :id RETURNING 1`,
      { id, message },
    );
  }

  async updateCredentials(
    id: string,
    credentialsSealed: string,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "Integration" SET "credentialsSealed" = :sealed, "updatedAt" = now()
          WHERE "id" = :id AND "status" <> 'DISCONNECTED' RETURNING 1`,
        { id, sealed: credentialsSealed },
      )) > 0
    );
  }

  async loadBreaker(id: string): Promise<BreakerState | null> {
    const r = await one<{
      consecutiveFailures: number;
      breakerOpenUntil: unknown;
    }>(
      this.db,
      `SELECT "consecutiveFailures", "breakerOpenUntil" FROM "Integration" WHERE "id" = :id`,
      { id },
    );
    if (!r) return null;
    const failures = Number(r.consecutiveFailures);
    return {
      failures,
      openUntil: toDate(r.breakerOpenUntil),
      // A probe in flight is held by the caller (the state `tryAcquire` returned); it is not stored.
      halfOpen: false,
      attentionRaised: failures >= BREAKER_FAILURES,
    };
  }

  @Transactional()
  async updateBreaker<T>(
    id: string,
    step: (current: BreakerState) => { state: BreakerState; result: T },
    inTransaction?: (result: T) => Promise<void>,
  ): Promise<T> {
    const r = await one<{
      consecutiveFailures: number;
      breakerOpenUntil: unknown;
    }>(
      this.db,
      `SELECT "consecutiveFailures", "breakerOpenUntil" FROM "Integration" WHERE "id" = :id FOR UPDATE`,
      { id },
    );
    if (!r) throw new Error('integration not found');
    const failures = Number(r.consecutiveFailures);
    const out = step({
      failures,
      openUntil: toDate(r.breakerOpenUntil),
      halfOpen: false,
      attentionRaised: failures >= BREAKER_FAILURES,
    });
    await rows(
      this.db,
      `UPDATE "Integration" SET "consecutiveFailures" = :failures, "breakerOpenUntil" = :openUntil, "updatedAt" = now()
        WHERE "id" = :id RETURNING 1`,
      { id, failures: out.state.failures, openUntil: out.state.openUntil },
    );
    await inTransaction?.(out.result);
    return out.result;
  }

  async saveBreaker(id: string, state: BreakerState): Promise<void> {
    await rows(
      this.db,
      `UPDATE "Integration" SET "consecutiveFailures" = :failures, "breakerOpenUntil" = :openUntil, "updatedAt" = now()
        WHERE "id" = :id RETURNING 1`,
      { id, failures: state.failures, openUntil: state.openUntil },
    );
  }
}
