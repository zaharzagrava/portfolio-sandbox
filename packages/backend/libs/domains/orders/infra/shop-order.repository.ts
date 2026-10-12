import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  OrderLineRecord,
  ShopOrderListRecord,
  ShopOrderRecord,
  ShopOrderRepository,
  ShopOrderStatus,
} from '../domain/ports';
import { safeNumber } from './safe-number';

/** The per-shop slices of an order. */
@Injectable()
export class SequelizeShopOrderRepository implements ShopOrderRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async pageForShop(
    shopId: string,
    status: ShopOrderStatus | null,
    limit: number,
    after: { createdAt: string; id: string } | null,
  ): Promise<ShopOrderListRecord[]> {
    const found = await this.sequelize.query<{
      id: string;
      orderId: string;
      status: ShopOrderStatus;
      subtotal: string | number;
      currency: string;
      buyerId: string;
      createdAt: Date;
    }>(
      `SELECT so."id", so."bisOrderId" AS "orderId", so."status", so."subtotal", o."currency", o."userId" AS "buyerId", so."createdAt"
       FROM "ShopOrder" so JOIN "BisOrder" o ON o."id" = so."bisOrderId"
       WHERE so."shopId" = :shopId
         AND (CAST(:status AS text) IS NULL OR so."status"::text = :status)
         AND (CAST(:afterCreatedAt AS timestamptz) IS NULL
              OR (so."createdAt", so."id") < (CAST(:afterCreatedAt AS timestamptz), CAST(:afterId AS uuid)))
       ORDER BY so."createdAt" DESC, so."id" DESC
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          shopId,
          status,
          limit,
          afterCreatedAt: after?.createdAt ?? null,
          afterId: after?.id ?? null,
        },
      },
    );
    return found.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      status: r.status,
      subtotalMinor: safeNumber(r.subtotal),
      currency: r.currency,
      buyerId: r.buyerId,
      createdAt: r.createdAt,
    }));
  }

  async lines(
    orderIds: string[],
    shopId: string | null,
  ): Promise<OrderLineRecord[]> {
    if (orderIds.length === 0) return [];
    const found = await this.sequelize.query<{
      orderId: string;
      shopOrderId: string;
      productId: string;
      shopId: string | null;
      title: string | null;
      quantity: number;
      priceAtPurchase: string | number;
      discountMinor: string | number;
      lineTotalMinor: string | number | null;
    }>(
      `SELECT i."bisOrderId" AS "orderId", so."id" AS "shopOrderId", i."productId", i."shopId", i."title", i."quantity",
              i."priceAtPurchase", i."discountMinor", i."lineTotalMinor"
       FROM "BisOrderItem" i
       JOIN "ShopOrder" so ON so."bisOrderId" = i."bisOrderId" AND so."shopId" = i."shopId"
       WHERE i."bisOrderId" IN (:orderIds)
         AND (CAST(:shopId AS uuid) IS NULL OR i."shopId" = CAST(:shopId AS uuid))
       ORDER BY i."bisOrderId", i."productId"`,
      { type: QueryTypes.SELECT, replacements: { orderIds, shopId } },
    );
    return found.map((r) => {
      const unitPriceMinor = safeNumber(r.priceAtPurchase);
      return {
        orderId: r.orderId,
        shopOrderId: r.shopOrderId,
        productId: r.productId,
        shopId: r.shopId,
        title: r.title,
        quantity: r.quantity,
        unitPriceMinor,
        discountMinor: safeNumber(r.discountMinor),
        lineTotalMinor:
          r.lineTotalMinor === null ? null : safeNumber(r.lineTotalMinor),
      };
    });
  }

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
