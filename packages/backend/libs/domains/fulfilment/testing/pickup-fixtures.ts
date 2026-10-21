import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import {
  ShopCreated,
  ShopDeleted,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  coalesceLatest,
  type Projector,
} from '@app/infrastructure/projections/projector';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { PickupModule } from '../pickup.module';
import { PickupProjectorModule } from '../pickup-projector.module';
import { PickupPointProjector } from '../infra/pickup-point.projector';
import { PickupProductProjector } from '../infra/pickup-product.projector';
import { PickupShopProjector } from '../infra/pickup-shop.projector';
import { PickupStockProjector } from '../infra/pickup-stock.projector';
import { AVAILABILITY_INDEX } from '../infra/availability-index';
import {
  PICKUP_AVAILABILITY_INDEX,
  type PickupAvailabilityIndex,
} from '../domain/pickup-ports';

/** Berlin: `ALEX` is the shopper (Alexanderplatz); the others are about 0.5 km, 3 km and 12 km away. */
export const ALEX = { lat: 52.5219, lng: 13.4132 };
export const MITTE = { lat: 52.5262, lng: 13.4092 };
export const KREUZBERG = { lat: 52.4986, lng: 13.3911 };
export const SPANDAU = { lat: 52.5354, lng: 13.2003 };

export interface PointBody {
  name?: string;
  address?: string;
  lat?: number;
  lng?: number;
  openingHours?: unknown;
}

export interface PickupWorld {
  /** Members of S1: U1 can write (STAFF), V1 only read (VIEWER). */
  u1: TestUser;
  v1: TestUser;
  /** Member of S2 only. */
  u2: TestUser;
  s1: { id: string };
  s2: { id: string };
}

export interface IndexedDoc {
  productId: string;
  pickupPointId: string;
  shopId: string;
  title: string;
  category: string;
  priceMinor: number;
  currency: string;
  pointName: string;
  pointAddress: string;
  quantity: number;
  [key: string]: unknown;
}

export interface OutboxEvent {
  type: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
}

export interface PickupTestApp extends CatalogTestApp {
  sql<T extends object = Record<string, unknown>>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  /** The pickup events the transactions wrote, oldest first, optionally of one type (full envelopes). */
  outbox(type?: string): Promise<OutboxEvent[]>;
  /** The seeded world: users U1, V1, U2 and shops S1, S2 (U1/V1 in S1, U2 in S2). */
  world(): Promise<PickupWorld>;
  product(shopId: string, seed?: ProductSeed): Promise<SeededProduct>;
  /** A point through the API as `user`; returns the created body. */
  createPoint(
    user: TestUser,
    shopId: string,
    body?: PointBody,
  ): Promise<{ id: string; [key: string]: unknown }>;
  /** A stock row through the API as `user`. */
  setStock(
    user: TestUser,
    shopId: string,
    pointId: string,
    productId: string,
    quantity: number,
  ): Promise<{ version: number; quantity: number }>;
  /** Drops and recreates the index (a delete-by-query would leave versioned tombstones). */
  clearIndex(): Promise<void>;
  refreshIndex(): Promise<void>;
  /** Every document of the index, by id. */
  documents(): Promise<Record<string, IndexedDoc & Record<string, unknown>>>;

  projectors: {
    stock: PickupStockProjector;
    point: PickupPointProjector;
    product: PickupProductProjector;
    shop: PickupShopProjector;
  };
  /** Hands events to a consumer as the framework would: reduced to the newest per aggregate when it coalesces. */
  feed(projector: Projector, events: EventEnvelope[]): Promise<unknown>;
  /** Runs the stock and point consumers over every outbox row written so far, then refreshes the index. */
  consume(): Promise<void>;

  /** Contract-valid events of the owners (S05, S03). */
  events: {
    shopCreated(shopId: string, version?: number): EventEnvelope;
    shopStatus(shopId: string, to: string, version: number): EventEnvelope;
    shopDeleted(shopId: string, version: number): EventEnvelope;
    productSnapshot(
      kind: 'created' | 'updated' | 'archived' | 'restored',
      product: { id: string; shopId: string },
      version: number,
      change?: Partial<ProductSnapshot>,
    ): EventEnvelope;
    productDeleted(
      product: { id: string; shopId: string },
      version: number,
    ): EventEnvelope;
  };
  /** Tells the consumers that the shop exists and is `ACTIVE` (what `tenancy.shop_created` does in production). */
  activateShop(shopId: string, version?: number): Promise<void>;
  /** Fault proxies in front of Redis (limiter) and the search engine, when asked for. */
  redisProxy: TcpFaultProxy | null;
  searchProxy: TcpFaultProxy | null;
}

let counter = 0;

/** The real `PickupModule` behind the production HTTP pipeline, real Postgres/PostGIS, Redis and Elasticsearch. */
export async function createPickupApp(
  options: Parameters<typeof createCatalogApp>[0] & {
    /** Put a fault proxy in front of Redis (the limiter's store) and/or the search engine. */
    proxies?: { redis?: boolean; search?: boolean };
  } = {},
): Promise<PickupTestApp> {
  const redisProxy = options.proxies?.redis
    ? await TcpFaultProxy.start({ host: 'localhost', port: 6400 })
    : null;
  const searchProxy = options.proxies?.search
    ? await TcpFaultProxy.start({ host: 'localhost', port: 9300 })
    : null;
  const base = await createCatalogApp({
    ...options,
    ...(redisProxy && {
      redisUrl: `redis://127.0.0.1:${redisProxy.port}/${new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').pathname.slice(1) || '0'}`,
    }),
    env: {
      ...options.env,
      ...(searchProxy && {
        ELASTICSEARCH_NODE: `http://127.0.0.1:${searchProxy.port}`,
      }),
    },
    extraImports: [
      PickupModule,
      PickupProjectorModule,
      ...(options.extraImports ?? []),
    ],
  });
  const app: INestApplication = base.app;
  const sequelize = app.get(Sequelize);
  const engine = app.get(SearchEngineClient);
  const projectors = {
    stock: app.get(PickupStockProjector),
    point: app.get(PickupPointProjector),
    product: app.get(PickupProductProjector),
    shop: app.get(PickupShopProjector),
  };

  const sql = <T extends object = Record<string, unknown>>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(query, { type: QueryTypes.SELECT, replacements });
  const envelopes = async () =>
    (
      await sql<{ payload: EventEnvelope }>(
        `SELECT "payload" FROM "Outbox" WHERE "topic" = 'pickup.events' ORDER BY "createdAt", "id"`,
      )
    ).map((r) => r.payload);

  const snapshot = (
    product: { id: string; shopId: string },
    version: number,
    change: Partial<ProductSnapshot> = {},
  ): ProductSnapshot => ({
    productId: product.id,
    shopId: product.shopId,
    title: 'AirPods Pro 3',
    description: 'Seeded product',
    brand: 'Acme',
    category: 'electronics',
    priceMinor: 10_000,
    currency: 'USD',
    rating: 0,
    tags: [],
    quantity: 0,
    inStock: false,
    status: 'ACTIVE',
    isSandbox: false,
    externalSku: null,
    productVersion: version,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    changedFields: [],
    ...change,
  });
  const definitions = {
    created: ProductCreated,
    updated: ProductUpdated,
    archived: ProductArchived,
    restored: ProductRestored,
  } as const;

  const t: PickupTestApp = {
    ...base,
    sql,
    async outbox(type) {
      return (await envelopes())
        .filter((e) => !type || e.type === type)
        .map((e) => ({
          type: e.type,
          aggregateId: e.aggregateId,
          aggregateVersion: e.aggregateVersion,
          payload: e.payload as Record<string, unknown>,
        }));
    },
    async world() {
      const [u1, v1, u2] = await Promise.all([
        base.newUser(),
        base.newUser(),
        base.newUser(),
      ]);
      const s1 = await createShop(app, null, { name: 'Electro' });
      const s2 = await createShop(app, null, { name: 'Other' });
      await addMember(app, s1.id, u1.id, 'STAFF');
      await addMember(app, s1.id, v1.id, 'VIEWER');
      await addMember(app, s2.id, u2.id, 'OWNER');
      return { u1, v1, u2, s1, s2 };
    },
    product: (shopId, seed = {}) => createProduct(app, { id: shopId }, seed),
    async createPoint(user, shopId, body = {}) {
      const n = ++counter;
      const res = await base
        .as(user)
        .post(`/api/shops/${shopId}/pickup-points`)
        .send({
          name: `Point ${n}`,
          address: `Street ${n}`,
          ...KREUZBERG,
          ...body,
        });
      if (res.status !== 201)
        throw new Error(
          `create point: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body;
    },
    async setStock(user, shopId, pointId, productId, quantity) {
      const res = await base
        .as(user)
        .put(`/api/shops/${shopId}/pickup-points/${pointId}/stock/${productId}`)
        .send({ quantity });
      if (res.status !== 200)
        throw new Error(`set stock: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async clearIndex() {
      await engine.deleteIndex(AVAILABILITY_INDEX);
      await app
        .get<PickupAvailabilityIndex>(PICKUP_AVAILABILITY_INDEX)
        .ensureIndex();
    },
    async refreshIndex() {
      if (await engine.indexExists(AVAILABILITY_INDEX))
        await engine.refresh(AVAILABILITY_INDEX);
    },
    async documents() {
      await t.refreshIndex();
      const res = await engine.search({
        index: AVAILABILITY_INDEX,
        size: 1000,
        query: { match_all: {} },
      });
      return Object.fromEntries(
        (res.hits.hits as { _id: string; _source: IndexedDoc }[]).map((h) => [
          h._id,
          h._source,
        ]),
      );
    },
    projectors,
    async feed(projector, events) {
      return projector.project(
        projector.coalesce ? coalesceLatest(events) : events,
      );
    },
    async consume() {
      const all = await envelopes();
      await t.feed(
        projectors.stock,
        all.filter((e) => e.type === 'pickup.stock_changed'),
      );
      await t.feed(
        projectors.point,
        all.filter((e) => e.type === 'pickup.point_changed'),
      );
      await t.refreshIndex();
    },
    events: {
      shopCreated: (shopId, version = 1) =>
        ShopCreated.create(shopId, version, {
          shopId,
          ownerId: null,
          name: 'Shop',
          slug: `shop-${shopId.slice(0, 8)}`,
          plan: 'STARTER',
          region: 'eu-central-1',
          shopVersion: version,
        }),
      shopStatus: (shopId, to, version) =>
        ShopStatusChanged.create(shopId, version, {
          shopId,
          from: 'ACTIVE',
          to: to as 'ACTIVE',
          shopVersion: version,
        }),
      shopDeleted: (shopId, version) =>
        ShopDeleted.create(shopId, version, { shopId, shopVersion: version }),
      productSnapshot: (kind, product, version, change) =>
        definitions[kind].create(
          product.id,
          version,
          snapshot(product, version, change),
        ),
      productDeleted: (product, version) =>
        ProductDeleted.create(product.id, version, {
          productId: product.id,
          shopId: product.shopId,
          productVersion: version,
        }),
    },
    async activateShop(shopId, version = 1) {
      await t.feed(projectors.shop, [t.events.shopCreated(shopId, version)]);
    },
    redisProxy,
    searchProxy,
    async reset() {
      for (const proxy of [redisProxy, searchProxy]) {
        if (proxy) {
          proxy.mode = 'pass';
          proxy.delayMs = 0;
        }
      }
      await base.reset();
      await t.clearIndex();
    },
    async close() {
      await base.close();
      await redisProxy?.close();
      await searchProxy?.close();
    },
  };
  return t;
}
