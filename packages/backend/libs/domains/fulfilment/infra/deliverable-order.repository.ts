import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  DeliverableOrderRecord,
  DeliverableOrderStore,
  DeliverableOrderWriteResult,
} from '../domain/delivery-ports';

const COLUMNS = `"orderId", "buyerId", "shopIds", "currency", "status", "orderVersion", "updatedAt"`;

/**
 * The fulfilment-owned copy of what the delivery needs to know about an order (S20 FR-045, R3), built from `order.paid`
 * and `order.cancelled`. Every write is guarded by `orderVersion` in the statement itself: a higher version wins, an
 * equal or lower one changes nothing, so redeliveries and reordering are harmless; a `CANCELLED` copy stays cancelled
 * unless a higher version says otherwise, and a cancel that arrives before the payment creates the row cancelled.
 */
@Injectable()
export class DeliverableOrderSqlRepository implements DeliverableOrderStore {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(orderId: string): Promise<DeliverableOrderRecord | null> {
    const [row] = await this.sequelize.query<DeliverableOrderRecord>(
      `SELECT ${COLUMNS} FROM "DeliverableOrder" WHERE "orderId" = :orderId`,
      { type: QueryTypes.SELECT, replacements: { orderId } },
    );
    return row ? { ...row, updatedAt: new Date(row.updatedAt) } : null;
  }

  async applyPaid(
    input: {
      orderId: string;
      buyerId: string;
      shopIds: string[];
      currency: string;
      orderVersion: number;
    },
    now: Date,
  ): Promise<DeliverableOrderWriteResult> {
    const rows = await this.sequelize.query(
      `INSERT INTO "DeliverableOrder" AS o ("orderId", "buyerId", "shopIds", "currency", "status", "orderVersion", "updatedAt")
       VALUES (:orderId, :buyerId, ARRAY(SELECT jsonb_array_elements_text(CAST(:shopIds AS jsonb)))::uuid[],
               :currency, 'PAID', :orderVersion, :now)
       ON CONFLICT ("orderId") DO UPDATE
          SET "buyerId" = EXCLUDED."buyerId", "shopIds" = EXCLUDED."shopIds", "currency" = EXCLUDED."currency",
              "status" = 'PAID', "orderVersion" = EXCLUDED."orderVersion", "updatedAt" = EXCLUDED."updatedAt"
        WHERE o."orderVersion" < EXCLUDED."orderVersion" AND o."status" = 'PAID'
       RETURNING "orderId"`,
      {
        type: QueryTypes.SELECT,
        replacements: { ...input, shopIds: JSON.stringify(input.shopIds), now },
      },
    );
    return rows.length > 0 ? 'applied' : 'ignored';
  }

  async applyCancelled(
    input: { orderId: string; buyerId: string; orderVersion: number },
    now: Date,
  ): Promise<DeliverableOrderWriteResult> {
    const rows = await this.sequelize.query(
      `INSERT INTO "DeliverableOrder" AS o ("orderId", "buyerId", "shopIds", "currency", "status", "orderVersion", "updatedAt")
       VALUES (:orderId, :buyerId, '{}', NULL, 'CANCELLED', :orderVersion, :now)
       ON CONFLICT ("orderId") DO UPDATE
          SET "status" = 'CANCELLED', "orderVersion" = EXCLUDED."orderVersion", "updatedAt" = EXCLUDED."updatedAt"
        WHERE o."orderVersion" < EXCLUDED."orderVersion"
       RETURNING "orderId"`,
      { type: QueryTypes.SELECT, replacements: { ...input, now } },
    );
    return rows.length > 0 ? 'applied' : 'ignored';
  }
}
