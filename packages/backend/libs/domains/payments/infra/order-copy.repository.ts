import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { OrderCopy, OrderCopyStatus } from '../domain/order-copy';
import type { OrderCopyRepository } from '../domain/ports';
import { safeNumber } from './safe-number';

interface CopyRow {
  orderId: string;
  userId: string;
  totalMinor: string | number | null;
  currency: string | null;
  status: OrderCopyStatus;
  reservedUntil: Date | null;
  orderVersion: number;
}

const toCopy = (r: CopyRow): OrderCopy => ({
  orderId: r.orderId,
  userId: r.userId,
  totalMinor: r.totalMinor === null ? null : safeNumber(r.totalMinor),
  currency: r.currency,
  status: r.status,
  reservedUntil: r.reservedUntil,
  orderVersion: r.orderVersion,
});

/** `PayableOrder`: one row per order, written by one version-guarded statement, never deleted (data-model.md). */
@Injectable()
export class SequelizeOrderCopyRepository implements OrderCopyRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async upsertVersioned(copy: OrderCopy, now: Date): Promise<boolean> {
    // A cancel event carries no amounts and a paid event no hold: the stored values are kept (COALESCE).
    const rows = await this.sequelize.query<{ orderId: string }>(
      `INSERT INTO "PayableOrder" ("orderId", "userId", "totalMinor", "currency", "status", "reservedUntil", "orderVersion", "updatedAt")
       VALUES (:orderId, :userId, :total, :currency, :status, :reservedUntil, :version, :now)
       ON CONFLICT ("orderId") DO UPDATE SET
         "userId" = EXCLUDED."userId",
         "totalMinor" = COALESCE(EXCLUDED."totalMinor", "PayableOrder"."totalMinor"),
         "currency" = COALESCE(EXCLUDED."currency", "PayableOrder"."currency"),
         "status" = EXCLUDED."status",
         "reservedUntil" = COALESCE(EXCLUDED."reservedUntil", "PayableOrder"."reservedUntil"),
         "orderVersion" = EXCLUDED."orderVersion",
         "updatedAt" = EXCLUDED."updatedAt"
       WHERE "PayableOrder"."orderVersion" < EXCLUDED."orderVersion"
       RETURNING "orderId"`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          orderId: copy.orderId,
          userId: copy.userId,
          total: copy.totalMinor,
          currency: copy.currency,
          status: copy.status,
          reservedUntil: copy.reservedUntil,
          version: copy.orderVersion,
          now,
        },
      },
    );
    return rows.length > 0;
  }

  async find(orderId: string): Promise<OrderCopy | null> {
    const [row] = await this.sequelize.query<CopyRow>(
      `SELECT "orderId", "userId", "totalMinor", "currency", "status", "reservedUntil", "orderVersion"
       FROM "PayableOrder" WHERE "orderId" = :orderId`,
      { type: QueryTypes.SELECT, replacements: { orderId } },
    );
    return row ? toCopy(row) : null;
  }
}
