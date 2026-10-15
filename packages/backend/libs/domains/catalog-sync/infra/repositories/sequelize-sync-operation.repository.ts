import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { OfflineConflictOpened } from '../../application/events/integration-events';
import type {
  ClaimInput,
  ConflictInput,
  OutcomeRecord,
  SyncOperationRepository,
  SyncOperationRow,
} from '../../domain/ports';
import { count, json, one, rows, toDate, toDateRequired } from './sql';

const COLUMNS = `"shopId", "opId", "deviceId", "userId", "type", "productId", "hlc", "fingerprint", "content", "status",
  "code", "detail", "quantityAfter", "productVersion", "claimedAt", "createdAt", "completedAt"`;

const toRow = (r: Record<string, unknown>): SyncOperationRow => ({
  shopId: r.shopId as string,
  opId: r.opId as string,
  deviceId: r.deviceId as string,
  userId: (r.userId ?? null) as string | null,
  type: r.type as SyncOperationRow['type'],
  productId: (r.productId ?? null) as string | null,
  hlc: r.hlc as string,
  fingerprint:
    typeof r.fingerprint === 'string' && r.fingerprint.length > 0
      ? r.fingerprint.trim()
      : null,
  content: (r.content ?? null) as Record<string, unknown> | null,
  status: r.status as SyncOperationRow['status'],
  code: (r.code ?? null) as SyncOperationRow['code'],
  detail: (r.detail ?? null) as Record<string, unknown> | null,
  quantityAfter: r.quantityAfter === null ? null : Number(r.quantityAfter),
  productVersion: r.productVersion === null ? null : Number(r.productVersion),
  claimedAt: toDateRequired(r.claimedAt),
  createdAt: toDateRequired(r.createdAt),
  completedAt: toDate(r.completedAt),
});

/** `SyncOperation` and, for the result transaction, `SyncConflict` (own tables). Every query carries the shop. */
@Injectable()
export class SequelizeSyncOperationRepository implements SyncOperationRepository {
  constructor(
    @InjectConnection() private readonly db: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  async claim(input: ClaimInput) {
    const inserted = await one(
      this.db,
      `INSERT INTO "SyncOperation" ("shopId", "opId", "deviceId", "userId", "type", "productId", "hlc", "fingerprint",
                                    "content", "status", "claimedAt", "createdAt")
       VALUES (:shopId, :opId, :deviceId, :userId, :type, :productId, :hlc, :fingerprint,
               CAST(:content AS jsonb), 'pending', :now, :now)
       ON CONFLICT ("shopId", "opId") DO NOTHING RETURNING 1`,
      {
        ...input,
        content: json(input.content),
      },
    );
    if (inserted) return { kind: 'claimed' as const };
    const row = await this.find(input.shopId, input.opId);
    if (!row) throw new Error('operation vanished between insert and read');
    return { kind: 'existing' as const, row };
  }

  async savePlan(
    shopId: string,
    opId: string,
    plan: Record<string, unknown>,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncOperation" SET "detail" = CAST(:plan AS jsonb)
          WHERE "shopId" = :shopId AND "opId" = :opId AND "status" = 'pending' RETURNING 1`,
        { shopId, opId, plan: json(plan) },
      )) > 0
    );
  }

  async recordRejected(input: ClaimInput, outcome: OutcomeRecord) {
    const inserted = await one(
      this.db,
      `INSERT INTO "SyncOperation" ("shopId", "opId", "deviceId", "userId", "type", "productId", "hlc", "fingerprint",
                                    "content", "status", "code", "detail", "claimedAt", "createdAt", "completedAt")
       VALUES (:shopId, :opId, :deviceId, :userId, :type, :productId, :hlc, :fingerprint,
               CAST(:content AS jsonb), :status, :code, CAST(:detail AS jsonb), :now, :now, :now)
       ON CONFLICT ("shopId", "opId") DO NOTHING RETURNING 1`,
      {
        ...input,
        content: json(input.content),
        status: outcome.status,
        code: outcome.code ?? null,
        detail: outcome.detail ? json(outcome.detail) : null,
      },
    );
    if (inserted) return { kind: 'recorded' as const };
    const row = await this.find(input.shopId, input.opId);
    if (!row) throw new Error('operation vanished between insert and read');
    return { kind: 'existing' as const, row };
  }

  async takeOver(
    shopId: string,
    opId: string,
    seenClaimedAt: Date,
    now: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `UPDATE "SyncOperation" SET "claimedAt" = :now
          WHERE "shopId" = :shopId AND "opId" = :opId AND "status" = 'pending' AND "claimedAt" = :seenClaimedAt
          RETURNING 1`,
        { shopId, opId, seenClaimedAt, now },
      )) > 0
    );
  }

  complete(
    shopId: string,
    opId: string,
    outcome: OutcomeRecord,
    conflict: ConflictInput | null,
    now: Date,
  ): Promise<boolean> {
    return this.transactions.run(async () => {
      const done = await count(
        this.db,
        `UPDATE "SyncOperation"
            SET "status" = :status, "code" = :code, "detail" = CAST(:detail AS jsonb), "quantityAfter" = :quantityAfter,
                "productVersion" = :productVersion, "completedAt" = :now
          WHERE "shopId" = :shopId AND "opId" = :opId AND "status" = 'pending' RETURNING 1`,
        {
          shopId,
          opId,
          now,
          status: outcome.status,
          code: outcome.code ?? null,
          detail: outcome.detail ? json(outcome.detail) : null,
          quantityAfter: outcome.quantityAfter ?? null,
          productVersion: outcome.productVersion ?? null,
        },
      );
      if (done === 0) return false;
      if (!conflict) return true;
      const created = await count(
        this.db,
        `INSERT INTO "SyncConflict" ("shopId", "opId", "deviceId", "productId", "kind", "requested", "applied",
                                     "shortfall", "quantityAfter", "status", "createdAt")
         VALUES (:shopId, :opId, :deviceId, :productId, :kind, :requested, :applied, :shortfall, :quantityAfter,
                 'open', :now)
         ON CONFLICT ("shopId", "opId") DO NOTHING RETURNING 1`,
        { shopId, opId, now, ...conflict },
      );
      if (created > 0)
        await this.outbox.append(
          OfflineConflictOpened.create(
            opId,
            0,
            {
              opId,
              shopId,
              deviceId: conflict.deviceId,
              productId: conflict.productId,
              kind: conflict.kind,
              requested: conflict.requested,
              applied: conflict.applied,
              shortfall: conflict.shortfall,
              quantityAfter: conflict.quantityAfter,
            },
            now,
          ),
        );
      return true;
    });
  }

  async find(shopId: string, opId: string): Promise<SyncOperationRow | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "SyncOperation" WHERE "shopId" = :shopId AND "opId" = :opId`,
      { shopId, opId },
    );
    return r && toRow(r);
  }

  async listStale(before: Date, limit: number): Promise<SyncOperationRow[]> {
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "SyncOperation" WHERE "status" = 'pending' AND "claimedAt" < :before
        ORDER BY "claimedAt" LIMIT :limit`,
      { before, limit },
    );
    return found.map(toRow);
  }

  purgeBefore(before: Date, limit: number): Promise<number> {
    return this.transactions.run(async () => {
      const removed = await rows<{ shopId: string; opId: string }>(
        this.db,
        `DELETE FROM "SyncOperation" o USING (
           SELECT s."shopId", s."opId" FROM "SyncOperation" s
            WHERE s."createdAt" < :before AND s."status" <> 'pending'
              AND NOT EXISTS (SELECT 1 FROM "SyncConflict" c
                               WHERE c."shopId" = s."shopId" AND c."opId" = s."opId" AND c."status" = 'open')
            ORDER BY s."createdAt" LIMIT :limit) d
          WHERE o."shopId" = d."shopId" AND o."opId" = d."opId"
         RETURNING o."shopId", o."opId"`,
        { before, limit },
      );
      // Dismissed conflicts follow their operation (no foreign key joins the two tables).
      if (removed.length > 0)
        await count(
          this.db,
          `DELETE FROM "SyncConflict" c USING (
             SELECT CAST(v->>'s' AS uuid) AS "shopId", CAST(v->>'o' AS uuid) AS "opId"
               FROM jsonb_array_elements(CAST(:keys AS jsonb)) v) k
            WHERE c."shopId" = k."shopId" AND c."opId" = k."opId" AND c."status" = 'dismissed' RETURNING 1`,
          {
            keys: json(removed.map((r) => ({ s: r.shopId, o: r.opId }))),
          },
        );
      return removed.length;
    });
  }

  async countPending(): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "SyncOperation" WHERE "status" = 'pending'`,
    );
    return Number(r?.n ?? 0);
  }

  deleteShop(shopId: string, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "SyncOperation" WHERE ctid IN (
         SELECT ctid FROM "SyncOperation" WHERE "shopId" = :shopId LIMIT :limit) RETURNING 1`,
      { shopId, limit },
    );
  }
}
