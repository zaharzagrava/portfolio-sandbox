import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { ApiList } from './public-catalog.service';

export interface ApiOrder {
  id: string;
  object: 'order';
  status: string;
  total: { amount: number; currency: string };
  lines: { product_id: string; quantity: number; unit_price: number }[];
  created_at: string;
}

/** The shop's slice of each order (ShopOrder + its own lines only - never other shops' items in the same cart). */
@Injectable()
export class PublicOrdersService {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async list(
    shopId: string,
    cursor?: string,
    limit = 20,
  ): Promise<ApiList<ApiOrder>> {
    const size = Math.min(Math.max(limit, 1), 100);
    const before = cursor ? Buffer.from(cursor, 'base64url').toString() : null;
    const rows = await this.query(
      shopId,
      `${before ? 'AND so.id < :before' : ''} ORDER BY so.id DESC LIMIT :limit`,
      { before, limit: size + 1 },
    );
    const page = rows.slice(0, size);
    return {
      object: 'list',
      data: page,
      has_more: rows.length > size,
      next_cursor:
        rows.length > size
          ? Buffer.from(page[page.length - 1].id).toString('base64url')
          : null,
    };
  }

  async get(shopId: string, id: string): Promise<ApiOrder> {
    const [order] = await this.query(shopId, 'AND so.id = :id', { id });
    if (!order)
      throw new NotFoundException({
        type: 'resource_missing',
        message: `No such order: ${id}`,
      });
    return order;
  }

  private async query(
    shopId: string,
    tail: string,
    replacements: Record<string, unknown>,
  ): Promise<ApiOrder[]> {
    const rows = await this.sequelize.query<{
      id: string;
      status: string;
      subtotal: string;
      currency: string;
      createdAt: Date;
      lines: { product_id: string; quantity: number; unit_price: string }[];
    }>(
      `SELECT so.id, so.status, so.subtotal, o.currency, so."createdAt",
              coalesce((SELECT json_agg(json_build_object('product_id', i."productId", 'quantity', i.quantity, 'unit_price', i."priceAtPurchase"))
                        FROM "BisOrderItem" i WHERE i."bisOrderId" = so."bisOrderId" AND i."shopId" = so."shopId"), '[]') AS lines
       FROM "ShopOrder" so JOIN "BisOrder" o ON o.id = so."bisOrderId"
       WHERE so."shopId" = :shopId ${tail}`,
      { type: QueryTypes.SELECT, replacements: { shopId, ...replacements } },
    );
    return rows.map((r) => ({
      id: r.id,
      object: 'order',
      status: r.status,
      total: { amount: Number(r.subtotal), currency: r.currency },
      lines: r.lines.map((l) => ({ ...l, unit_price: Number(l.unit_price) })),
      created_at: new Date(r.createdAt).toISOString(),
    }));
  }
}
