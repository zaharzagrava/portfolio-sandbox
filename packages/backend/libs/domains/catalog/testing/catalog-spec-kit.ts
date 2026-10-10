import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { CacheService } from '@app/infrastructure/cache';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { productCacheKey } from '../infra/product-cache';
import type { CatalogTestApp } from './catalog-app';

/** Shared setup of the catalog e2e files: a shop with one user per role, and cache and outbox probes. */
export interface ShopWorld {
  shop: { id: string };
  owner: Awaited<ReturnType<CatalogTestApp['newUser']>>;
  admin: ShopWorld['owner'];
  staff: ShopWorld['owner'];
  viewer: ShopWorld['owner'];
  outsider: ShopWorld['owner'];
}

export async function createShopWorld(
  t: CatalogTestApp,
  options: Parameters<typeof createShop>[2] = {},
): Promise<ShopWorld> {
  const owner = await t.newUser();
  const admin = await t.newUser();
  const staff = await t.newUser();
  const viewer = await t.newUser();
  const outsider = await t.newUser();
  const shop = await createShop(t.app, owner, options);
  await addMember(t.app, shop.id, admin.id, 'ADMIN');
  await addMember(t.app, shop.id, staff.id, 'STAFF');
  await addMember(t.app, shop.id, viewer.id, 'VIEWER');
  return { shop, owner, admin, staff, viewer, outsider };
}

/** Stores a (versioned) entry for the product the way a reader would, so a spec can watch it disappear. */
export const warmProductEntry = (
  app: INestApplication,
  id: string,
  version = 1,
) =>
  app
    .get(CacheService)
    .getOrLoad(productCacheKey(id), () => Promise.resolve({ id, version }), {
      ttlMs: 60_000,
      swrMs: 300_000,
      negativeTtlMs: 10_000,
      versionOf: (v: { version: number }) => v.version,
    });

export const productEntryExists = async (
  app: INestApplication,
  id: string,
): Promise<boolean> =>
  (await app.get(RedisService).client.exists(productCacheKey(id))) === 1;

/** Counts outbox rows of the catalog events (any aggregate); a validation failure must leave it at zero. */
export async function catalogEventCount(
  app: INestApplication,
): Promise<number> {
  const [found] = await app
    .get(Sequelize)
    .query<{ n: string }>(
      `SELECT count(*) AS n FROM "Outbox" WHERE "type" LIKE 'catalog.%'`,
      { type: QueryTypes.SELECT },
    );
  return Number(found.n);
}

/**
 * Holds `ACCESS EXCLUSIVE` on a table from a second, real connection until `release()`: a statement on the table waits
 * (a real lock, not a stub), so a spec can keep a loader busy for as long as it needs, or force a lock timeout.
 */
export async function holdTableLock(
  app: INestApplication,
  table: string,
  connect: { host: string; port: number } = {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5400),
  },
): Promise<{ release(): Promise<void> }> {
  const cfg = app.get(Sequelize).config;
  const client = new Client({
    ...connect,
    user: cfg.username,
    password: cfg.password ?? undefined,
    database: cfg.database,
  });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
  return {
    async release() {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

/** A problem body without the members that differ per occurrence. */
export const stableProblem = (body: Record<string, unknown>) => {
  const { requestId, instance, traceId, ...rest } = body;
  void requestId;
  void instance;
  void traceId;
  return rest;
};
