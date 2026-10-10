import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import { decideShopState, type GuardOutcome } from '../../domain/projection-guard';
import type {
  ShopStateChange,
  ShopStateRecord,
  ShopStateRepository,
} from '../../domain/ports';

interface StateRow {
  shopId: string;
  status: ShopStateRecord['status'];
  plan: ShopStateRecord['plan'];
  shopVersion: string | null;
  offboarding: boolean;
  lastEventAt: Date;
}

const toRecord = (r: StateRow): ShopStateRecord => ({
  shopId: r.shopId,
  status: r.status,
  plan: r.plan,
  shopVersion: r.shopVersion === null ? null : Number(r.shopVersion),
  offboarding: r.offboarding,
  lastEventAt: new Date(r.lastEventAt),
});

const EPOCH = new Date(0);

/** `SearchShopState`: the copy of the shop facts search needs, one row per shop, guarded as `decideShopState` says. */
@Injectable()
export class SequelizeShopStateRepository implements ShopStateRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  async read(shopIds: string[]): Promise<Map<string, ShopStateRecord>> {
    const out = new Map<string, ShopStateRecord>();
    if (shopIds.length === 0) return out;
    const rows = await this.sequelize.query<StateRow>(
      `SELECT "shopId", "status", "plan", "shopVersion", "offboarding", "lastEventAt"
       FROM "SearchShopState" WHERE "shopId" = ANY($1::uuid[])`,
      { type: QueryTypes.SELECT, bind: [shopIds] },
    );
    for (const r of rows) out.set(r.shopId, toRecord(r));
    return out;
  }

  async apply(
    change: ShopStateChange,
  ): Promise<{ outcome: GuardOutcome; record: ShopStateRecord }> {
    return this.transactions.run(async (tx) => {
      // A default row makes the lock below possible for a shop never seen; any incoming event is newer than it.
      await this.sequelize.query(
        `INSERT INTO "SearchShopState" ("shopId", "status", "plan", "shopVersion", "offboarding", "lastEventAt")
         VALUES ($1, 'ACTIVE', NULL, NULL, false, $2) ON CONFLICT ("shopId") DO NOTHING`,
        { bind: [change.shopId, EPOCH], transaction: tx },
      );
      const [row] = await this.sequelize.query<StateRow>(
        `SELECT "shopId", "status", "plan", "shopVersion", "offboarding", "lastEventAt"
         FROM "SearchShopState" WHERE "shopId" = $1 FOR UPDATE`,
        { type: QueryTypes.SELECT, bind: [change.shopId], transaction: tx },
      );
      const stored = toRecord(row);
      const outcome = decideShopState(
        {
          shopVersion: stored.shopVersion,
          lastEventAt: stored.lastEventAt.getTime(),
        },
        {
          shopVersion: change.shopVersion,
          occurredAt: change.occurredAt.getTime(),
        },
      );
      if (outcome === 'stale') return { outcome, record: stored };
      const next: ShopStateRecord = {
        shopId: stored.shopId,
        status: change.status ?? stored.status,
        plan: change.plan === undefined ? stored.plan : change.plan,
        offboarding: change.offboarding ?? stored.offboarding,
        shopVersion: change.shopVersion ?? stored.shopVersion,
        lastEventAt: new Date(
          Math.max(stored.lastEventAt.getTime(), change.occurredAt.getTime()),
        ),
      };
      await this.sequelize.query(
        `UPDATE "SearchShopState"
         SET "status" = $2, "plan" = $3, "shopVersion" = $4, "offboarding" = $5, "lastEventAt" = $6
         WHERE "shopId" = $1`,
        {
          bind: [
            next.shopId,
            next.status,
            next.plan,
            next.shopVersion,
            next.offboarding,
            next.lastEventAt,
          ],
          transaction: tx,
        },
      );
      return { outcome, record: next };
    });
  }
}
