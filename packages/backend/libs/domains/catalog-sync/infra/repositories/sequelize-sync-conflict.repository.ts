import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import type {
  SyncConflictPage,
  SyncConflictRecord,
  SyncConflictRepository,
  SyncConflictStatus,
} from '../../domain/ports';
import { KeysetCursorCodec } from './keyset-cursor';
import { count, one, rows, toDate, toDateRequired } from './sql';

const COLUMNS = `"shopId", "opId", "deviceId", "productId", "kind", "requested", "applied", "shortfall", "quantityAfter",
  "status", "createdAt", "dismissedAt", "dismissedBy"`;

const toConflict = (r: Record<string, unknown>): SyncConflictRecord => ({
  shopId: r.shopId as string,
  opId: r.opId as string,
  deviceId: r.deviceId as string,
  productId: r.productId as string,
  kind: r.kind as SyncConflictRecord['kind'],
  requested: Number(r.requested),
  applied: Number(r.applied),
  shortfall: Number(r.shortfall),
  quantityAfter: Number(r.quantityAfter),
  status: r.status as SyncConflictStatus,
  createdAt: toDateRequired(r.createdAt),
  dismissedAt: toDate(r.dismissedAt),
  dismissedBy: (r.dismissedBy ?? null) as string | null,
});

/** `SyncConflict` (own table), distinct from S08's `StockConflict`. The cursor is bound to the shop and the status. */
@Injectable()
export class SequelizeSyncConflictRepository implements SyncConflictRepository {
  private readonly codec: KeysetCursorCodec;

  constructor(
    @InjectConnection() private readonly db: Sequelize,
    config: ApiConfigService,
  ) {
    this.codec = new KeysetCursorCodec(config.get('integration_cursor_key'));
  }

  async page(
    shopId: string,
    query: { status: SyncConflictStatus; limit: number; cursor?: string },
  ): Promise<SyncConflictPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(query.limit)));
    const scope = `sync-conflicts:${shopId}:${query.status}`;
    const replacements: Record<string, unknown> = {
      shopId,
      status: query.status,
      n: limit + 1,
    };
    let after = '';
    if (query.cursor !== undefined) {
      const c = this.codec.decode(scope, query.cursor);
      replacements.cts = c.ts;
      replacements.cid = c.id;
      after = `AND ("createdAt", "opId") < (CAST(:cts AS timestamptz), CAST(:cid AS uuid))`;
    }
    const found = await rows<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS}, "createdAt"::text AS "_ts" FROM "SyncConflict"
        WHERE "shopId" = :shopId AND "status" = :status ${after}
        ORDER BY "createdAt" DESC, "opId" DESC LIMIT :n`,
      replacements,
    );
    const items = found.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toConflict),
      nextCursor:
        found.length > limit && last
          ? this.codec.encode(scope, String(last._ts), String(last.opId))
          : null,
    };
  }

  async dismiss(
    shopId: string,
    opId: string,
    actorId: string,
    now: Date,
  ): Promise<SyncConflictRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `UPDATE "SyncConflict" SET "status" = 'dismissed', "dismissedAt" = :now, "dismissedBy" = :actorId
        WHERE "shopId" = :shopId AND "opId" = :opId AND "status" = 'open' RETURNING ${COLUMNS}`,
      { shopId, opId, actorId, now },
    );
    return r && toConflict(r);
  }

  async find(shopId: string, opId: string): Promise<SyncConflictRecord | null> {
    const r = await one<Record<string, unknown>>(
      this.db,
      `SELECT ${COLUMNS} FROM "SyncConflict" WHERE "shopId" = :shopId AND "opId" = :opId`,
      { shopId, opId },
    );
    return r && toConflict(r);
  }

  async countOpen(): Promise<number> {
    const r = await one<{ n: string }>(
      this.db,
      `SELECT count(*) AS n FROM "SyncConflict" WHERE "status" = 'open'`,
    );
    return Number(r?.n ?? 0);
  }

  deleteShop(shopId: string, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "SyncConflict" WHERE ctid IN (
         SELECT ctid FROM "SyncConflict" WHERE "shopId" = :shopId LIMIT :limit) RETURNING 1`,
      { shopId, limit },
    );
  }
}
