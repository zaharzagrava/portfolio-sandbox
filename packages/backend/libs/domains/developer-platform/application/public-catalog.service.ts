import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { ProductService, productChanged } from '@app/domains/catalog';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';

export interface ApiProduct {
  id: string;
  object: 'product';
  title: string;
  description: string;
  price: { amount: number; currency: string };
  stock: number;
  category: string;
  brand: string;
  created_at: string;
  updated_at: string;
  shop?: { id: string; name: string };
}

export interface ApiList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export const BULK_STOCK_QUEUE = 'bulk-stock-updates';
const SYNC_BULK_LIMIT = 100;
const ASYNC_CHUNK = 500;
const PRODUCT_FIELDS = [
  'id',
  'object',
  'title',
  'description',
  'price',
  'stock',
  'category',
  'brand',
  'created_at',
  'updated_at',
  'shop',
];

interface ProductRow {
  id: string;
  title: string;
  description: string;
  price: string;
  quantity: number;
  category: string;
  brand: string;
  createdAt: Date;
  updatedAt: Date;
  shopName?: string;
  shopId: string;
}

const toApi = (p: ProductRow, expandShop: boolean): ApiProduct => ({
  id: p.id,
  object: 'product',
  title: p.title,
  description: p.description,
  price: { amount: Number(p.price), currency: 'usd' },
  stock: p.quantity,
  category: p.category,
  brand: p.brand,
  created_at: new Date(p.createdAt).toISOString(),
  updated_at: new Date(p.updatedAt).toISOString(),
  ...(expandShop && { shop: { id: p.shopId, name: p.shopName ?? '' } }),
});

/** Sparse fieldsets: `fields=id,title,price` (04/01 §2.4) - smaller payloads for ERPs syncing 100k SKUs. */
export function pickFields<T extends object>(
  resource: T,
  fields?: string,
): Partial<T> {
  if (!fields) return resource;
  const wanted = new Set([
    'id',
    'object',
    ...fields.split(',').map((f) => f.trim()),
  ]);
  const unknown = [...wanted].filter((f) => !PRODUCT_FIELDS.includes(f));
  if (unknown.length)
    throw new BadRequestException({
      type: 'invalid_fields',
      message: `Unknown field(s): ${unknown.join(', ')}`,
    });
  return Object.fromEntries(
    Object.entries(resource).filter(([k]) => wanted.has(k)),
  ) as Partial<T>;
}

/**
 * Products + stock for the public API. Every query is scoped by the key's
 * shopId (never by an id from the URL alone): another shop's product id
 * simply returns 404 (BOLA, OWASP API1).
 */
@Injectable()
export class PublicCatalogService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly products: ProductService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
    private readonly queue: TaskQueue,
  ) {}

  /** Keyset (cursor) pagination on the uuidv7 id: stable under inserts, O(limit) at any depth - no OFFSET. */
  async list(
    shopId: string,
    opts: { cursor?: string; limit?: number; expand?: string[] },
  ): Promise<ApiList<ApiProduct>> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const after = opts.cursor
      ? Buffer.from(opts.cursor, 'base64url').toString()
      : null;
    const expandShop = !!opts.expand?.includes('shop');
    const rows = await this.sequelize.query<ProductRow>(
      `SELECT p.id, p.title, p.description, p.price, p.quantity, p.category, p.brand, p."createdAt", p."updatedAt", p."shopId"${expandShop ? ', s.name AS "shopName"' : ''}
       FROM "Product" p ${expandShop ? 'JOIN "Shop" s ON s.id = p."shopId"' : ''}
       WHERE p."shopId" = :shopId ${after ? 'AND p.id > :after' : ''}
       ORDER BY p.id LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, after, limit: limit + 1 },
      },
    );
    const page = rows.slice(0, limit);
    return {
      object: 'list',
      data: page.map((r) => toApi(r, expandShop)),
      has_more: rows.length > limit,
      next_cursor:
        rows.length > limit
          ? Buffer.from(page[page.length - 1].id).toString('base64url')
          : null,
    };
  }

  async get(
    shopId: string,
    id: string,
    expand: string[] = [],
  ): Promise<ApiProduct> {
    const expandShop = expand.includes('shop');
    const [row] = await this.sequelize.query<ProductRow>(
      `SELECT p.id, p.title, p.description, p.price, p.quantity, p.category, p.brand, p."createdAt", p."updatedAt", p."shopId", s.name AS "shopName"
       FROM "Product" p JOIN "Shop" s ON s.id = p."shopId" WHERE p.id = :id AND p."shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { id, shopId } },
    );
    if (!row)
      throw new NotFoundException({
        type: 'resource_missing',
        message: `No such product: ${id}`,
      });
    return toApi(row, expandShop);
  }

  async create(
    shopId: string,
    sellerId: string,
    body: {
      title: string;
      description?: string;
      price: number;
      stock?: number;
      category: string;
      brand?: string;
    },
  ) {
    const created = await this.products.create(
      {
        title: body.title,
        description: body.description ?? '',
        price: body.price,
        quantity: body.stock ?? 0,
        category: body.category,
        brand: body.brand ?? '',
      },
      sellerId,
      shopId,
    );
    return this.get(shopId, (created as { id: string }).id);
  }

  async update(
    shopId: string,
    id: string,
    patch: {
      title?: string;
      description?: string;
      price?: number;
      stock?: number;
    },
  ) {
    await this.transactions.run(async (transaction) => {
      const [, meta] = await this.sequelize.query(
        `UPDATE "Product" SET title = coalesce(:title, title), description = coalesce(:description, description), price = coalesce(:price, price),
                quantity = coalesce(:stock, quantity), version = version + 1, "updatedAt" = now()
         WHERE id = :id AND "shopId" = :shopId`,
        {
          replacements: {
            id,
            shopId,
            title: patch.title ?? null,
            description: patch.description ?? null,
            price: patch.price ?? null,
            stock: patch.stock ?? null,
          },
          transaction,
        },
      );
      if (!(meta as { rowCount?: number }).rowCount)
        throw new NotFoundException({
          type: 'resource_missing',
          message: `No such product: ${id}`,
        });
      await this.outbox.append(productChanged(id), transaction);
    });
    return this.get(shopId, id);
  }

  /**
   * ERP stock sync: ≤ 100 items applied synchronously in ONE statement; larger
   * files (up to 10k) go to SQS in chunks of 500 and are tracked as a job -
   * one request instead of 10k, and the API process never holds a long transaction.
   */
  async bulkStock(
    shopId: string,
    items: { productId: string; stock: number }[],
  ) {
    if (items.length <= SYNC_BULK_LIMIT) {
      const updated = await this.applyStock(shopId, items);
      return {
        object: 'bulk_stock_update',
        status: 'succeeded',
        updated,
        not_found: items.length - updated,
      };
    }
    const jobId = `bsu_${uuidv7().replace(/-/g, '')}`;
    const chunks = Math.ceil(items.length / ASYNC_CHUNK);
    await this.redis.client
      .multi()
      .hset(`bulkstock:${jobId}`, {
        shopId,
        total: items.length,
        chunks,
        done: 0,
        updated: 0,
      })
      .expire(`bulkstock:${jobId}`, 86_400)
      .exec();
    for (let i = 0; i < items.length; i += ASYNC_CHUNK) {
      await this.queue.enqueue(BULK_STOCK_QUEUE, {
        jobId,
        shopId,
        items: items.slice(i, i + ASYNC_CHUNK),
      });
    }
    return {
      object: 'bulk_stock_update',
      id: jobId,
      status: 'processing',
      total: items.length,
    };
  }

  async bulkStockStatus(shopId: string, jobId: string) {
    const job = await this.redis.client.hgetall(`bulkstock:${jobId}`);
    if (!job.shopId || job.shopId !== shopId)
      throw new NotFoundException({
        type: 'resource_missing',
        message: `No such job: ${jobId}`,
      });
    const done = Number(job.done) === Number(job.chunks);
    return {
      object: 'bulk_stock_update',
      id: jobId,
      status: done ? 'succeeded' : 'processing',
      total: Number(job.total),
      updated: Number(job.updated),
    };
  }

  /** Worker side of the async path. */
  async applyChunk(msg: {
    jobId: string;
    shopId: string;
    items: { productId: string; stock: number }[];
  }) {
    const updated = await this.applyStock(msg.shopId, msg.items);
    await this.redis.client
      .multi()
      .hincrby(`bulkstock:${msg.jobId}`, 'updated', updated)
      .hincrby(`bulkstock:${msg.jobId}`, 'done', 1)
      .exec();
  }

  private async applyStock(
    shopId: string,
    items: { productId: string; stock: number }[],
  ): Promise<number> {
    if (items.length === 0) return 0;
    return this.transactions.run(async (transaction) => {
      const rows = await this.sequelize.query<{ id: string }>(
        `UPDATE "Product" p SET quantity = u.stock, version = p.version + 1, "updatedAt" = now()
         FROM unnest(CAST(:ids AS uuid[]), CAST(:stocks AS int[])) AS u(id, stock)
         WHERE p.id = u.id AND p."shopId" = :shopId AND p.quantity IS DISTINCT FROM u.stock
         RETURNING p.id`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            shopId,
            ids: `{${items.map((i) => i.productId).join(',')}}`,
            stocks: `{${items.map((i) => Math.max(0, Math.floor(i.stock))).join(',')}}`,
          },
          transaction,
        },
      );
      for (const { id } of rows)
        await this.outbox.append(productChanged(id), transaction);
      return rows.length;
    });
  }
}
