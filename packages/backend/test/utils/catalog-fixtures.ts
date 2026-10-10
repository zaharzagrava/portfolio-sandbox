import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { ProductModel } from '@app/domains/catalog';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';

/**
 * Shared seeding for specs that need products (S05 T004). Test code may touch every table (IX.6): these write straight
 * to the `Product` table with explicit columns and never through the API under test, so they write no event and no
 * history row.
 */
export interface ProductSeed {
  id?: string;
  title?: string;
  description?: string;
  brand?: string;
  category?: string;
  priceMinor?: number;
  currency?: string;
  quantity?: number;
  tags?: string[];
  status?: 'ACTIVE' | 'ARCHIVED';
  version?: number;
  viewCount?: number;
  isSandbox?: boolean;
  externalSku?: string | null;
  createdBy?: string | null;
  rating?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SeededProduct {
  id: string;
  shopId: string;
  title: string;
  version: number;
  status: 'ACTIVE' | 'ARCHIVED';
  quantity: number;
  priceMinor: number;
  createdAt: Date;
}

const model = (app: INestApplication) =>
  app.get<typeof ProductModel>(getModelToken(ProductModel));

const row = (shopId: string, seed: ProductSeed, index = 0) => {
  const createdAt = seed.createdAt ?? new Date();
  return {
    id: seed.id ?? uuidv7(),
    shopId,
    createdBy: seed.createdBy ?? null,
    title: seed.title ?? `Product ${index + 1} ${uuidv7().slice(-6)}`,
    description: seed.description ?? 'Seeded product',
    brand: seed.brand ?? 'Acme',
    category: seed.category ?? 'electronics',
    price: seed.priceMinor ?? 10_000,
    priceMinor: seed.priceMinor ?? 10_000,
    currency: seed.currency ?? 'USD',
    quantity: seed.quantity ?? 10,
    tags: seed.tags ?? [],
    status: seed.status ?? 'ACTIVE',
    version: seed.version ?? 1,
    viewCount: seed.viewCount ?? 0,
    isSandbox: seed.isSandbox ?? false,
    externalSku: seed.externalSku ?? null,
    rating: seed.rating ?? 0,
    createdAt,
    updatedAt: seed.updatedAt ?? createdAt,
  };
};

const toSeeded = (r: ReturnType<typeof row>): SeededProduct => ({
  id: r.id,
  shopId: r.shopId,
  title: r.title,
  version: r.version,
  status: r.status,
  quantity: r.quantity,
  priceMinor: r.priceMinor,
  createdAt: r.createdAt,
});

export async function createProduct(
  app: INestApplication,
  shop: { id: string },
  overrides: ProductSeed = {},
): Promise<SeededProduct> {
  const r = row(shop.id, overrides);
  await model(app).create(r, { silent: true });
  return toSeeded(r);
}

/** `n` products with strictly increasing `createdAt` one second apart (oldest first in the array). */
export async function createProducts(
  app: INestApplication,
  shop: { id: string },
  n: number,
  overrides: ProductSeed = {},
): Promise<SeededProduct[]> {
  const base = (overrides.createdAt ?? new Date()).getTime() - n * 1_000;
  const rows = Array.from({ length: n }, (_, i) =>
    row(shop.id, { ...overrides, createdAt: new Date(base + i * 1_000) }, i),
  );
  await model(app).bulkCreate(rows);
  return rows.map(toSeeded);
}

export async function productRow<T extends Record<string, unknown>>(
  app: INestApplication,
  id: string,
): Promise<T | undefined> {
  const [found] = await app
    .get(Sequelize)
    .query<T>(`SELECT * FROM "Product" WHERE "id" = :id`, {
      type: QueryTypes.SELECT,
      replacements: { id },
    });
  return found;
}

export async function productCount(
  app: INestApplication,
  where = 'TRUE',
  replacements: Record<string, unknown> = {},
): Promise<number> {
  const [found] = await app
    .get(Sequelize)
    .query<{ n: string }>(
      `SELECT count(*) AS n FROM "Product" WHERE ${where}`,
      {
        type: QueryTypes.SELECT,
        replacements,
      },
    );
  return Number(found.n);
}

/** Outbox rows of one product, oldest first, with the envelope fields a spec asserts on. */
export async function productEvents(app: INestApplication, productId: string) {
  const rows = await outboxRowsFor(app, productId);
  return rows
    .filter((r) => r.kind === 'event')
    .map((r) => {
      const envelope = r.payload as {
        type: string;
        version: number;
        aggregateId: string;
        aggregateVersion: number;
        eventId: string;
        occurredAt: string;
        payload: Record<string, unknown>;
      };
      return { topic: r.topic, aggregateType: r.aggregateType, ...envelope };
    });
}

/**
 * Records every statement the real connection runs while `fn` executes (observation only; nothing is stubbed).
 * `match` narrows the result, for example `/"Product"/`.
 */
export async function recordStatements<T>(
  app: INestApplication,
  fn: () => Promise<T>,
  match: RegExp = /./,
): Promise<{ result: T; statements: string[] }> {
  const sequelize = app.get(Sequelize);
  const options = sequelize.options as { logging?: unknown };
  const previous = options.logging;
  const statements: string[] = [];
  options.logging = (sql: string) => {
    if (match.test(sql)) statements.push(sql);
  };
  try {
    const result = await fn();
    return { result, statements };
  } finally {
    options.logging = previous;
  }
}
