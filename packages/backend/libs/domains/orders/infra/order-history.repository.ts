import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { HistoryRecord, OrderHistoryRepository } from '../domain/ports';
import type { OrderStatus } from '../domain/order-state';

/** Append-only transition history (`OrderEvent`): one row per move, written in the move's transaction. */
@Injectable()
export class SequelizeOrderHistoryRepository implements OrderHistoryRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async append(entry: {
    orderId: string;
    from: OrderStatus | null;
    to: OrderStatus;
    reason: string | null;
    actor: string | null;
    amountMinor?: number;
    at: Date;
  }): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "OrderEvent" ("bisOrderId", "fromStatus", "toStatus", "reason", "actor", "amountMinor", "createdAt")
       VALUES (:orderId, :from, :to, :reason, :actor, :amountMinor, :at)`,
      {
        replacements: {
          orderId: entry.orderId,
          from: entry.from,
          to: entry.to,
          reason: entry.reason,
          actor: entry.actor,
          amountMinor: entry.amountMinor ?? null,
          at: entry.at,
        },
      },
    );
  }

  async has(orderId: string, reason: string, actor: string): Promise<boolean> {
    const found = await this.sequelize.query(
      `SELECT 1 FROM "OrderEvent" WHERE "bisOrderId" = :orderId AND "reason" = :reason AND "actor" = :actor LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { orderId, reason, actor } },
    );
    return found.length > 0;
  }

  timeline(orderId: string): Promise<HistoryRecord[]> {
    return this.sequelize.query<HistoryRecord>(
      `SELECT "toStatus" AS "status", "fromStatus", "reason", "actor", "createdAt" AS "at"
       FROM "OrderEvent" WHERE "bisOrderId" = :orderId ORDER BY "id"`,
      { type: QueryTypes.SELECT, replacements: { orderId } },
    );
  }
}
