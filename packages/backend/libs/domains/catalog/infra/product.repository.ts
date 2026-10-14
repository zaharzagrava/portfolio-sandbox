import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  TransactionRunner,
  getActiveTransaction,
} from '@app/infrastructure/context';
import { MAX_QUANTITY } from '../domain/stock-rule';
import type {
  ExternalProductFields,
  NewProduct,
  ProductChanges,
  ProductListFilter,
  ProductListRow,
  ProductRepository,
} from '../domain/ports';
import type { CursorKey } from '../domain/product-cursor';
import type { ProductStatus } from '../domain/product-status';
import type { ProductRecord } from '../domain/product-view';

/** Deadline of a public read statement, lock wait included (research D-9). */
const READ_DEADLINE_MS = 2_000;

export const PRODUCT_COLUMNS = `p."id", p."shopId", p."createdBy", p."title", p."description", p."brand", p."category",
  p."priceMinor", p."currency", p."rating", p."tags", p."quantity", p."status", p."isSandbox", p."externalSku",
  p."version", p."viewCount", p."createdAt", p."updatedAt"`;

const CREATED_AT_KEY = `to_char(p."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey"`;

/** The columns an update may set, by the key of `ProductChanges`; SQL never takes a column name from a caller. */
const UPDATABLE = [
  'title',
  'description',
  'brand',
  'category',
  'priceMinor',
  'currency',
  'quantity',
  'tags',
] as const satisfies ReadonlyArray<keyof ProductChanges>;

interface Row {
  id: string;
  shopId: string;
  createdBy: string | null;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: string;
  currency: string;
  rating: number;
  tags: string[];
  quantity: number;
  status: ProductStatus;
  isSandbox: boolean;
  externalSku: string | null;
  version: number;
  viewCount: string;
  createdAt: Date;
  updatedAt: Date;
  createdAtKey?: string;
}

export const toProductRecord = (row: Row): ProductRecord => ({
  id: row.id,
  shopId: row.shopId,
  createdBy: row.createdBy,
  title: row.title,
  description: row.description,
  brand: row.brand,
  category: row.category,
  priceMinor: Number(row.priceMinor),
  currency: row.currency,
  rating: row.rating,
  tags: row.tags,
  quantity: row.quantity,
  status: row.status,
  isSandbox: row.isSandbox,
  externalSku: row.externalSku,
  version: row.version,
  viewCount: Number(row.viewCount),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Postgres adapter of `ProductRepository`: the only code of the catalog that reads or writes `Product` for the write
 * path (III.1). Parameterised SQL only; every statement carries the shop in its predicate (III.4); sort and status
 * come from fixed text, never from input.
 */
@Injectable()
export class SequelizeProductRepository implements ProductRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
  ) {}

  private rows<T extends object>(sql: string, bind: unknown[]): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      bind,
      transaction: getActiveTransaction(),
      type: QueryTypes.SELECT,
    });
  }

  async insert(input: NewProduct): Promise<ProductRecord> {
    const [row] = await this.rows<Row>(
      `INSERT INTO "Product" AS p ("id","shopId","createdBy","isSandbox","title","description","brand","category",
         "price","priceMinor","currency","quantity","tags","status","version","viewCount","rating","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12::jsonb,'ACTIVE',1,0,0,$13,$13)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        input.id,
        input.shopId,
        input.createdBy,
        input.isSandbox,
        input.title,
        input.description,
        input.brand,
        input.category,
        input.priceMinor,
        input.currency,
        input.quantity,
        JSON.stringify(input.tags),
        input.now,
      ],
    );
    return toProductRecord(row);
  }

  async findInShop(shopId: string, productId: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${PRODUCT_COLUMNS} FROM "Product" p WHERE p."id" = $1 AND p."shopId" = $2`,
      [productId, shopId],
    );
    return row ? toProductRecord(row) : null;
  }

  async update(
    shopId: string,
    productId: string,
    expectedVersion: number,
    changes: ProductChanges,
    now: Date,
    options: { anyStatus?: boolean } = {},
  ) {
    const bind: unknown[] = [productId, shopId, expectedVersion, now];
    const sets: string[] = [];
    for (const key of UPDATABLE) {
      const value = changes[key];
      if (value === undefined) continue;
      bind.push(key === 'tags' ? JSON.stringify(value) : value);
      sets.push(`"${key}" = $${bind.length}${key === 'tags' ? '::jsonb' : ''}`);
    }
    const [row] = await this.rows<Row>(
      `UPDATE "Product" p SET ${sets.join(', ')}${sets.length ? ', ' : ''}"version" = p."version" + 1, "updatedAt" = $4
       WHERE p."id" = $1 AND p."shopId" = $2 AND p."version" = $3${options.anyStatus ? '' : ` AND p."status" = 'ACTIVE'`}
       RETURNING ${PRODUCT_COLUMNS}`,
      bind,
    );
    return row ? toProductRecord(row) : null;
  }

  async findByIds(ids: string[], shopId?: string): Promise<ProductRecord[]> {
    if (ids.length === 0) return [];
    const bind: unknown[] = [ids];
    if (shopId !== undefined) bind.push(shopId);
    const found = await this.rows<Row>(
      `SELECT ${PRODUCT_COLUMNS} FROM "Product" p
       WHERE p."id" = ANY($1::uuid[])${shopId !== undefined ? ` AND p."shopId" = $2` : ''}`,
      bind,
    );
    return found.map(toProductRecord);
  }

  async lockForStock(productIds: string[]): Promise<ProductRecord[]> {
    const found = await this.rows<Row>(
      `SELECT ${PRODUCT_COLUMNS} FROM "Product" p WHERE p."id" = ANY($1::uuid[]) ORDER BY p."id" FOR UPDATE`,
      [productIds],
    );
    return found.map(toProductRecord);
  }

  async applyDelta(
    shopId: string,
    productId: string,
    delta: number,
    now: Date,
  ): Promise<ProductRecord | null> {
    const [row] = await this.rows<Row>(
      `UPDATE "Product" p SET "quantity" = p."quantity" + $3::int, "version" = p."version" + 1, "updatedAt" = $4
       WHERE p."id" = $1 AND p."shopId" = $2
         AND p."quantity" + $3::int BETWEEN 0 AND ${MAX_QUANTITY}
         AND ($3::int > 0 OR p."status" = 'ACTIVE')
       RETURNING ${PRODUCT_COLUMNS}`,
      [productId, shopId, delta, now],
    );
    return row ? toProductRecord(row) : null;
  }

  async lockByExternalSku(shopId: string, externalSku: string) {
    const [row] = await this.rows<Row>(
      `SELECT ${PRODUCT_COLUMNS} FROM "Product" p
       WHERE p."shopId" = $1 AND p."externalSku" = $2 FOR UPDATE`,
      [shopId, externalSku],
    );
    return row ? toProductRecord(row) : null;
  }

  async insertExternal(
    shopId: string,
    id: string,
    isSandbox: boolean,
    fields: ExternalProductFields,
    now: Date,
  ) {
    const [row] = await this.rows<Row>(
      `INSERT INTO "Product" AS p ("id","shopId","createdBy","isSandbox","title","description","brand","category",
         "price","priceMinor","currency","quantity","tags","status","version","viewCount","rating","createdAt","updatedAt","externalSku")
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11::jsonb,'ACTIVE',1,0,0,$12,$12,$13)
       ON CONFLICT ("shopId","externalSku") WHERE "externalSku" IS NOT NULL DO NOTHING
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        id,
        shopId,
        isSandbox,
        fields.title,
        fields.description,
        fields.brand,
        fields.category,
        fields.priceMinor,
        fields.currency,
        fields.quantity ?? 0,
        JSON.stringify(fields.tags),
        now,
        fields.externalSku,
      ],
    );
    return row ? toProductRecord(row) : null;
  }

  async transition(
    shopId: string,
    productId: string,
    from: ProductStatus,
    to: ProductStatus,
    expectedVersion: number,
    now: Date,
  ) {
    const [row] = await this.rows<Row>(
      `UPDATE "Product" p SET "status" = $5, "version" = p."version" + 1, "updatedAt" = $4
       WHERE p."id" = $1 AND p."shopId" = $2 AND p."version" = $3 AND p."status" = $6
       RETURNING ${PRODUCT_COLUMNS}`,
      [productId, shopId, expectedVersion, now, to, from],
    );
    return row ? toProductRecord(row) : null;
  }

  async findVisibleByIds(ids: string[]): Promise<ProductRecord[]> {
    if (ids.length === 0) return [];
    // The read deadline of the public path (research D-9): a table lock or a slow plan fails fast instead of holding
    // a pooled connection. `set_config(..., true)` is local to this short transaction.
    const found = await this.runner.run(
      () =>
        this.rows<Row>(
          `SELECT ${PRODUCT_COLUMNS} FROM "Product" p
           LEFT JOIN "ProductShopState" s ON s."shopId" = p."shopId"
           WHERE p."id" = ANY($1::uuid[]) AND p."status" = 'ACTIVE' AND NOT p."isSandbox"
             AND COALESCE(s."status", 'ACTIVE') = 'ACTIVE'`,
          [ids],
        ),
      { statementTimeoutMs: READ_DEADLINE_MS, lockTimeoutMs: READ_DEADLINE_MS },
    );
    return found.map(toProductRecord);
  }

  async listByShop(
    shopId: string,
    filter: ProductListFilter,
    after: CursorKey | null,
    limit: number,
  ): Promise<ProductListRow[]> {
    const bind: unknown[] = [shopId, filter.status];
    const where = [`p."shopId" = $1`, `p."status" = $2`];
    if (filter.category !== null) {
      bind.push(filter.category);
      where.push(`p."category" = $${bind.length}`);
    }
    if (filter.inStock !== null)
      where.push(filter.inStock ? `p."quantity" > 0` : `p."quantity" = 0`);
    if (after) {
      bind.push(after.createdAt, after.id);
      where.push(
        `(p."createdAt", p."id") < ($${bind.length - 1}::timestamptz, $${bind.length}::uuid)`,
      );
    }
    bind.push(limit);
    const found = await this.rows<Row>(
      `SELECT ${PRODUCT_COLUMNS}, ${CREATED_AT_KEY} FROM "Product" p
       WHERE ${where.join(' AND ')}
       ORDER BY p."createdAt" DESC, p."id" DESC LIMIT $${bind.length}`,
      bind,
    );
    return found.map((row) => ({
      record: toProductRecord(row),
      key: { createdAt: row.createdAtKey!, id: row.id },
    }));
  }
}
