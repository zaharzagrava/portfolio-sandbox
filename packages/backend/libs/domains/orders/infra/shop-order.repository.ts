import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  ShopOrderRecord,
  ShopOrderRepository,
  ShopOrderStatus,
} from '../domain/ports';
import { safeNumber } from './safe-number';

/** The per-shop slices of an order. */
@Injectable()
export class SequelizeShopOrderRepository implements ShopOrderRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async forOrder(orderId: string): Promise<ShopOrderRecord[]> {
    const rows = await this.sequelize.query<{
      id: string;
      orderId: string;
      shopId: string | null;
      subtotal: string | number;
      status: ShopOrderStatus;
    }>(
      `SELECT "id", "bisOrderId" AS "orderId", "shopId", "subtotal", "status"
       FROM "ShopOrder" WHERE "bisOrderId" = :orderId ORDER BY "shopId", "id"`,
      { type: QueryTypes.SELECT, replacements: { orderId } },
    );
    return rows.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      shopId: r.shopId,
      subtotalMinor: safeNumber(r.subtotal),
      status: r.status,
    }));
  }

  async setStatus(
    orderId: string,
    status: ShopOrderStatus,
    now: Date,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "ShopOrder" SET "status" = :status, "updatedAt" = :now WHERE "bisOrderId" = :orderId`,
      { replacements: { orderId, status, now } },
    );
  }
}
