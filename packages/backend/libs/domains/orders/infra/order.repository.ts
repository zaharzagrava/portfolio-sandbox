import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  NewOrder,
  OrderItemRecord,
  OrderRecord,
  OrderRepository,
} from '../domain/ports';
import type { OrderStatus } from '../domain/order-state';
import { safeNumber } from './safe-number';

interface OrderRow {
  id: string;
  userId: string;
  status: OrderStatus;
  total: string | number;
  currency: string;
  reservedUntil: Date | null;
  version: number;
  idempotencyKey: string | null;
  requestHash: string | null;
  cancelReason: OrderRecord['cancelReason'];
  paymentRef: string | null;
  createdAt: Date;
}

const COLUMNS = `"id", "userId", "status", "total", "currency", "reservedUntil", "version", "idempotencyKey",
  "requestHash", "cancelReason", "paymentRef", "createdAt"`;

const toRecord = (r: OrderRow): OrderRecord => ({
  id: r.id,
  userId: r.userId,
  status: r.status,
  totalMinor: safeNumber(r.total),
  currency: r.currency,
  reservedUntil: r.reservedUntil,
  version: r.version,
  idempotencyKey: r.idempotencyKey,
  requestHash: r.requestHash,
  cancelReason: r.cancelReason,
  paymentRef: r.paymentRef,
  createdAt: r.createdAt,
});

/**
 * `BisOrder` and its owned child rows. Every statement joins the active transaction (CLS). Foreign orders are absent:
 * `findForUser` filters in the statement, never after the read (III.4). Times come from the caller (the injected clock).
 */
@Injectable()
export class SequelizeOrderRepository implements OrderRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: object,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  async createPending(input: NewOrder): Promise<OrderRecord | null> {
    // Child rows go in ascending product id: a foreign key from `BisOrderItem.productId` (until the contract migration
    // drops it) takes a KEY SHARE lock on each product row, and the stock command locks product rows in the same
    // order, so two checkouts holding the same products in opposite cart order can never wait on each other (AS-34).
    const order: NewOrder = {
      ...input,
      items: [...input.items].sort((a, b) =>
        a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
      ),
    };
    const inserted = await this.select<OrderRow>(
      `INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash",
                               "version", "createdAt", "updatedAt")
       VALUES (:id, :userId, 'PENDING', :total, :currency, :key, :hash, 1, :now, :now)
       ON CONFLICT ("userId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      {
        id: order.id,
        userId: order.userId,
        total: order.totalMinor,
        currency: order.currency,
        key: order.idempotencyKey,
        hash: order.requestHash,
        now: order.now,
      },
    );
    if (inserted.length === 0) return null;

    await this.sequelize.query(
      `INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase",
                                   "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
       SELECT uuidv7(), :orderId, i."productId"::uuid, i."title", i."quantity", i."unitPrice", i."discount", i."lineTotal",
              i."shopId"::uuid, :now, :now
       FROM jsonb_to_recordset(CAST(:items AS jsonb)) AS i(
         "productId" text, "title" text, "quantity" int, "unitPrice" bigint, "discount" bigint, "lineTotal" bigint,
         "shopId" text)`,
      {
        replacements: {
          orderId: order.id,
          now: order.now,
          items: JSON.stringify(
            order.items.map((i) => ({
              productId: i.productId,
              title: i.title,
              quantity: i.quantity,
              unitPrice: i.unitPriceMinor,
              discount: i.discountMinor,
              lineTotal: i.lineTotalMinor,
              shopId: i.shopId,
            })),
          ),
        },
      },
    );
    await this.sequelize.query(
      `INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
       SELECT uuidv7(), :orderId, s."shopId"::uuid, s."subtotal", 'PENDING', :now, :now
       FROM jsonb_to_recordset(CAST(:shops AS jsonb)) AS s("shopId" text, "subtotal" bigint)`,
      {
        replacements: {
          orderId: order.id,
          now: order.now,
          shops: JSON.stringify(
            order.shopOrders.map((s) => ({
              shopId: s.shopId,
              subtotal: s.subtotalMinor,
            })),
          ),
        },
      },
    );
    await this.sequelize.query(
      `INSERT INTO "StockReservation" ("id", "bisOrderId", "productId", "quantity", "source", "status", "expiresAt", "createdAt")
       SELECT uuidv7(), :orderId, r."productId"::uuid, r."quantity", 'CATALOG', 'REQUESTED', :now, :now
       FROM jsonb_to_recordset(CAST(:reservations AS jsonb)) AS r("productId" text, "quantity" int)`,
      {
        replacements: {
          orderId: order.id,
          now: order.now,
          reservations: JSON.stringify(
            order.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
            })),
          ),
        },
      },
    );
    await this.sequelize.query(
      `INSERT INTO "OrderEvent" ("bisOrderId", "fromStatus", "toStatus", "reason", "actor", "createdAt")
       VALUES (:orderId, NULL, 'PENDING', NULL, :actor, :now)`,
      {
        replacements: {
          orderId: order.id,
          actor: `user:${order.userId}`,
          now: order.now,
        },
      },
    );
    return toRecord(inserted[0]);
  }

  async findById(orderId: string): Promise<OrderRecord | null> {
    const [row] = await this.select<OrderRow>(
      `SELECT ${COLUMNS} FROM "BisOrder" WHERE "id" = :orderId`,
      { orderId },
    );
    return row ? toRecord(row) : null;
  }

  async findForUser(
    orderId: string,
    userId: string,
  ): Promise<OrderRecord | null> {
    const [row] = await this.select<OrderRow>(
      `SELECT ${COLUMNS} FROM "BisOrder" WHERE "id" = :orderId AND "userId" = :userId`,
      { orderId, userId },
    );
    return row ? toRecord(row) : null;
  }

  async findByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<OrderRecord | null> {
    const [row] = await this.select<OrderRow>(
      `SELECT ${COLUMNS} FROM "BisOrder" WHERE "userId" = :userId AND "idempotencyKey" = :idempotencyKey`,
      { userId, idempotencyKey },
    );
    return row ? toRecord(row) : null;
  }

  async items(orderId: string): Promise<OrderItemRecord[]> {
    const rows = await this.select<{
      productId: string;
      shopId: string | null;
      title: string | null;
      quantity: number;
      priceAtPurchase: string | number;
      discountMinor: string | number;
      lineTotalMinor: string | number | null;
    }>(
      `SELECT "productId", "shopId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor"
       FROM "BisOrderItem" WHERE "bisOrderId" = :orderId ORDER BY "productId"`,
      { orderId },
    );
    return rows.map((r) => ({
      productId: r.productId,
      shopId: r.shopId,
      title: r.title,
      quantity: r.quantity,
      unitPriceMinor: safeNumber(r.priceAtPurchase),
      discountMinor: safeNumber(r.discountMinor),
      lineTotalMinor:
        r.lineTotalMinor === null ? null : safeNumber(r.lineTotalMinor),
    }));
  }

  async move(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    patch: {
      reservedUntil?: Date | null;
      cancelReason?: OrderRecord['cancelReason'];
      paymentRef?: string | null;
    },
    now: Date,
  ): Promise<OrderRecord | null> {
    const sets = [
      '"status" = :to',
      '"version" = "version" + 1',
      '"updatedAt" = :now',
    ];
    if (patch.reservedUntil !== undefined)
      sets.push('"reservedUntil" = :reservedUntil');
    if (patch.cancelReason !== undefined)
      sets.push('"cancelReason" = :cancelReason');
    if (patch.paymentRef !== undefined) sets.push('"paymentRef" = :paymentRef');
    const [row] = await this.select<OrderRow>(
      `UPDATE "BisOrder" SET ${sets.join(', ')} WHERE "id" = :orderId AND "status" = :from RETURNING ${COLUMNS}`,
      {
        orderId,
        from,
        to,
        now,
        reservedUntil: patch.reservedUntil ?? null,
        cancelReason: patch.cancelReason ?? null,
        paymentRef: patch.paymentRef ?? null,
      },
    );
    return row ? toRecord(row) : null;
  }

  async expiredReserved(now: Date, limit: number): Promise<string[]> {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "BisOrder" WHERE "status" = 'RESERVED' AND "reservedUntil" <= :now
       ORDER BY "reservedUntil", "id" LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { now, limit },
    );
    return rows.map((r) => r.id);
  }

  async stalePending(before: Date, limit: number): Promise<string[]> {
    const rows = await this.select<{ id: string }>(
      `SELECT "id" FROM "BisOrder" WHERE "status" = 'PENDING' AND "createdAt" < :before
       ORDER BY "createdAt", "id" LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { before, limit },
    );
    return rows.map((r) => r.id);
  }
}
