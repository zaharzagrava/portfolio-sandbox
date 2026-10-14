import type { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';

/**
 * Shared seeding for specs that need finished orders with several shop slices (S42). Test code may write every table
 * (IX.6): the order is written with explicit columns, and the code under test reads it back through the orders
 * capability's exported service.
 */
export interface SeededOrder {
  orderId: string;
  /** shop id → the shop order id of that shop's slice */
  shopOrders: Map<string, string>;
}

const exec = async (
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown>,
): Promise<void> => {
  await app.get(Sequelize).query(sql, { replacements });
};

export async function seedOrder(
  app: INestApplication,
  input: {
    buyerId: string;
    lines: Array<{
      productId: string;
      shopId: string;
      quantity: number;
      unitPriceMinor: number;
      title?: string;
    }>;
    status?: 'PENDING' | 'PAID';
    currency?: string;
    createdAt?: Date;
  },
): Promise<SeededOrder> {
  const orderId = uuidv7();
  const now = input.createdAt ?? new Date();
  const total = input.lines.reduce(
    (s, l) => s + l.unitPriceMinor * l.quantity,
    0,
  );
  await exec(
    app,
    `INSERT INTO "BisOrder" ("id", "userId", "status", "total", "currency", "idempotencyKey", "requestHash", "version", "createdAt", "updatedAt")
     VALUES (:orderId, :buyerId, :status, :total, :currency, :key, 'seed', 1, :now, :now)`,
    {
      orderId,
      buyerId: input.buyerId,
      status: input.status ?? 'PENDING',
      total,
      currency: input.currency ?? 'USD',
      key: `seed-${orderId}`,
      now,
    },
  );
  const shopOrders = new Map<string, string>();
  for (const shopId of new Set(input.lines.map((l) => l.shopId))) {
    const shopOrderId = uuidv7();
    shopOrders.set(shopId, shopOrderId);
    await exec(
      app,
      `INSERT INTO "ShopOrder" ("id", "bisOrderId", "shopId", "subtotal", "status", "createdAt", "updatedAt")
       VALUES (:shopOrderId, :orderId, :shopId, :subtotal, :status, :now, :now)`,
      {
        shopOrderId,
        orderId,
        shopId,
        subtotal: input.lines
          .filter((l) => l.shopId === shopId)
          .reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0),
        status: input.status ?? 'PENDING',
        now,
      },
    );
  }
  for (const l of input.lines)
    await exec(
      app,
      `INSERT INTO "BisOrderItem" ("id", "bisOrderId", "productId", "title", "quantity", "priceAtPurchase", "discountMinor", "lineTotalMinor", "shopId", "createdAt", "updatedAt")
       VALUES (uuidv7(), :orderId, :productId, :title, :quantity, :price, 0, :lineTotal, :shopId, :now, :now)`,
      {
        orderId,
        productId: l.productId,
        title: l.title ?? 'Seeded item',
        quantity: l.quantity,
        price: l.unitPriceMinor,
        lineTotal: l.unitPriceMinor * l.quantity,
        shopId: l.shopId,
        now,
      },
    );
  return { orderId, shopOrders };
}
