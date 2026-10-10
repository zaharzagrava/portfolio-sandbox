import { Injectable, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  CacheModule,
  CacheService,
  CacheUnavailable,
} from '@app/infrastructure/cache';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createProduct,
  productEvents,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { readTopic } from '@app/test/utils/kafka-test';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductUpdated,
} from './application/events/product-events';
import { PUBLIC_PRODUCT_ENTRY } from './application/public-product.service';
import { productInvalidationLag } from './domain/product-metrics';
import { ProductCacheInvalidator } from './infra/product-cache-invalidator.projector';
import { productCacheKey } from './infra/product-cache';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  productEntryExists,
  type ShopWorld,
} from './testing/catalog-spec-kit';

@Module({
  imports: [CacheModule],
  providers: [ProductCacheInvalidator],
  exports: [ProductCacheInvalidator],
})
class InvalidatorProbeModule {}

const PRODUCT_SELECT = /FROM "Product" p/;
const get = (t: CatalogTestApp, id: string) =>
  t.http().get(`/api/products/${id}`);
const counter = (result: string) =>
  MetricsRegistry.value('catalog_product_invalidation_total', { result }) ?? 0;

const snapshot = (
  productId: string,
  shopId: string,
  version: number,
  changedFields: ProductSnapshot['changedFields'] = [],
): ProductSnapshot => ({
  productId,
  shopId,
  title: 'T',
  description: '',
  brand: 'B',
  category: 'c',
  priceMinor: 100,
  currency: 'USD',
  rating: 0,
  tags: [],
  quantity: 1,
  inStock: true,
  status: 'ACTIVE',
  isSandbox: false,
  externalSku: null,
  productVersion: version,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  changedFields,
});

describe('Product cache invalidation', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let invalidator: ProductCacheInvalidator;
  let redis: RedisService;
  const updated = (
    id: string,
    version: number,
    occurredAt?: Date,
  ): EventEnvelope =>
    ProductUpdated.create(
      id,
      version,
      snapshot(id, w.shop.id, version, ['priceMinor']),
      occurredAt,
    );
  const minimum = async (id: string) =>
    redis.client.get(`{${productCacheKey(id)}}:min`);

  beforeAll(async () => {
    t = await createCatalogApp({ extraImports: [InvalidatorProbeModule] });
    invalidator = t.app.get(ProductCacheInvalidator);
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('delete-on-write (AS-39)', () => {
    it('S05 AS-39: after each kind of write the entry is gone before the response and an immediate read returns the committed data', async () => {
      const base = `/api/shops/${w.shop.id}/products`;
      const product = await createProduct(t.app, w.shop, {
        version: 1,
        priceMinor: 1_000,
      });

      await get(t, product.id).expect(200);
      expect(await productEntryExists(t.app, product.id)).toBe(true);
      await t
        .as(w.staff)
        .patch(`${base}/${product.id}`)
        .send({ expectedVersion: 1, priceMinor: 2_000 })
        .expect(200);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      expect((await get(t, product.id).expect(200)).body.priceMinor).toBe(
        2_000,
      );

      await t
        .as(w.staff)
        .post(`${base}/${product.id}/archive`)
        .send({ expectedVersion: 2 })
        .expect(200);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      await get(t, product.id).expect(404);

      await t
        .as(w.staff)
        .post(`${base}/${product.id}/restore`)
        .send({ expectedVersion: 3 })
        .expect(200);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      await get(t, product.id).expect(200);
    });

    it('S05 AS-39: a create deletes a cached not-found for the new id and stores no value', async () => {
      const id = uuidv7();
      await get(t, id).expect(404);
      expect(await productEntryExists(t.app, id)).toBe(true);
      const created = await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/products`)
        .send({ title: 'T', brand: 'B', category: 'c', priceMinor: 100 })
        .expect(201);
      expect(await productEntryExists(t.app, created.body.id)).toBe(false);
    });
  });

  describe('event-driven invalidation (AS-40 to AS-47)', () => {
    it('S05 AS-40: the consumer repairs an entry whose writer-side delete failed, records the minimum and has its own consumer group', async () => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      await get(t, product.id).expect(200);

      // The cache refuses the writer's call (the store is down at that instant); the write itself must still commit.
      jest
        .spyOn(CacheService.prototype, 'invalidateIfOlder')
        .mockRejectedValueOnce(new CacheUnavailable('store down'));
      await t
        .as(w.staff)
        .patch(`/api/shops/${w.shop.id}/products/${product.id}`)
        .send({ expectedVersion: 3, priceMinor: 555 })
        .expect(200);
      jest.restoreAllMocks();
      // The entry for version 3 is still there: the writer's delete failed.
      expect(await productEntryExists(t.app, product.id)).toBe(true);

      const [event] = await productEvents(t.app, product.id);
      expect(event.type).toBe('catalog.product_updated');
      await invalidator.project([
        ProductUpdated.create(
          product.id,
          event.aggregateVersion,
          event.payload as ProductSnapshot,
        ),
      ]);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      expect(await minimum(product.id)).toMatch(/^4:/);
      expect((await get(t, product.id).expect(200)).body.version).toBe(4);

      // Its own consumer group on the product topic: a slow search projector never delays it.
      expect(invalidator.name).toBe('product-cache-invalidator');
      expect(invalidator.topics).toEqual(['products.events']);
    });

    it('S05 AS-41: the same event delivered twice with a fresh entry loaded in between is one applied and one skipped, with no extra miss', async () => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      await get(t, product.id).expect(200);
      await t.app
        .get(Sequelize)
        .query(
          `UPDATE "Product" SET "version" = 4, "priceMinor" = 900 WHERE "id" = :id`,
          { replacements: { id: product.id } },
        );
      const event = updated(product.id, 4);
      const applied = counter('applied');
      const skipped = counter('skipped');

      await invalidator.project([event]);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      expect((await get(t, product.id).expect(200)).body.version).toBe(4);

      const second = await recordStatements(
        t.app,
        async () => {
          await invalidator.project([event]);
          return get(t, product.id).expect(200);
        },
        PRODUCT_SELECT,
      );
      expect(second.statements).toHaveLength(0);
      expect(second.result.body.version).toBe(4);
      expect(counter('applied')).toBe(applied + 1);
      expect(counter('skipped')).toBe(skipped + 1);
    });

    it('S05 AS-42: an event for version 4 arriving after the entry holds 5, or the minimum is 5, is ignored', async () => {
      const product = await createProduct(t.app, w.shop, { version: 5 });
      await get(t, product.id).expect(200);
      await invalidator.project([updated(product.id, 4)]);
      expect(await productEntryExists(t.app, product.id)).toBe(true);
      expect(await minimum(product.id)).toBeNull();

      await invalidator.project([
        updated(product.id, 5),
        updated(product.id, 6),
      ]);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      expect(await minimum(product.id)).toMatch(/^6:/);
      await invalidator.project([updated(product.id, 4)]);
      expect(await minimum(product.id)).toMatch(/^6:/);
    });

    it('S05 AS-43: a slow reader that loaded version 3 cannot store it after the invalidation for version 4; a stored value of version 4 or higher is accepted', async () => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      const cache = t.app.get(CacheService);
      const key = productCacheKey(product.id);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = cache.getOrLoad(
        key,
        async () => {
          await gate;
          return { ...snapshotView(product.id, w.shop.id), version: 3 };
        },
        PUBLIC_PRODUCT_ENTRY,
      );
      await t.app
        .get(Sequelize)
        .query(
          `UPDATE "Product" SET "version" = 4, "priceMinor" = 4444 WHERE "id" = :id`,
          { replacements: { id: product.id } },
        );
      await invalidator.project([updated(product.id, 4)]);
      release();
      expect((await slow)?.version).toBe(3); // the slow reader still answers its own caller
      expect(await productEntryExists(t.app, product.id)).toBe(false);

      const next = await get(t, product.id).expect(200);
      expect(next.body.version).toBe(4);
      expect(next.body.priceMinor).toBe(4_444);
      expect(await productEntryExists(t.app, product.id)).toBe(true);
    });

    it('S05 AS-45: a batch of 10 events about 3 products issues one invalidation per product with the highest version', async () => {
      const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
      const spy = jest.spyOn(CacheService.prototype, 'invalidateIfOlder');
      await invalidator.project([
        updated(a, 2),
        updated(b, 5),
        updated(a, 4),
        updated(c, 1),
        updated(a, 3),
        updated(b, 7),
        updated(c, 2),
        updated(b, 6),
        updated(a, 1),
        updated(c, 3),
      ]);
      const calls = spy.mock.calls.map(([key, version]) => [key, version]);
      expect(calls).toHaveLength(3);
      expect(calls).toEqual(
        expect.arrayContaining([
          [productCacheKey(a), 4],
          [productCacheKey(b), 7],
          [productCacheKey(c), 3],
        ]),
      );
    });

    it('S05 AS-46: the lag histogram records now - occurredAt per applied event; the 99th percentile of 100 events is under 5 s', async () => {
      const recorded: number[] = [];
      const spy = jest.spyOn(productInvalidationLag, 'record');
      spy.mockImplementation((value: number) => void recorded.push(value));
      const now = t.clock.now().getTime();
      const events = Array.from({ length: 100 }, (_, i) =>
        updated(uuidv7(), 2, new Date(now - (i % 30) * 100)),
      );
      await invalidator.project(events);
      expect(recorded).toHaveLength(100);
      const sorted = [...recorded].sort((x, y) => x - y);
      expect(sorted[98]).toBeLessThan(5);
      expect(sorted[99]).toBeCloseTo(2.9, 1);
      expect(sorted[0]).toBeCloseTo(0, 3);
    });

    it('S05 AS-47: a product_deleted event removes the entry, positive or negative, unconditionally; the next read is 404 and cached', async () => {
      const product = await createProduct(t.app, w.shop, { version: 4 });
      await get(t, product.id).expect(200);
      const unlinks = async () => {
        const info = await redis.client.info('commandstats');
        return Number(/cmdstat_unlink:calls=(\d+)/.exec(info)?.[1] ?? 0);
      };
      const before = await unlinks();

      const deleted = ProductDeleted.create(product.id, 5, {
        productId: product.id,
        shopId: w.shop.id,
        productVersion: 5,
      });
      await t.app
        .get(Sequelize)
        .query(`DELETE FROM "Product" WHERE "id" = :id`, {
          replacements: { id: product.id },
        });
      await invalidator.project([deleted]);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      expect(await unlinks()).toBeGreaterThan(before);

      await get(t, product.id).expect(404);
      expect(await productEntryExists(t.app, product.id)).toBe(true); // negative entry
      await invalidator.project([deleted]);
      expect(await productEntryExists(t.app, product.id)).toBe(false);
      const again = await recordStatements(
        t.app,
        async () => {
          await get(t, product.id).expect(404);
          await get(t, product.id).expect(404);
        },
        PRODUCT_SELECT,
      );
      expect(again.statements).toHaveLength(1);
    });

    it('S05 AS-47: created and archived events are handled like updates', async () => {
      const id = uuidv7();
      const spy = jest.spyOn(CacheService.prototype, 'invalidateIfOlder');
      await invalidator.project([
        ProductCreated.create(id, 1, snapshot(id, w.shop.id, 1)),
        ProductArchived.create(id, 2, {
          ...snapshot(id, w.shop.id, 2),
          status: 'ARCHIVED',
        }),
      ]);
      expect(spy.mock.calls.map(([, v]) => v)).toEqual([2]);
    });
  });
});

describe('Product cache invalidation through the event stream', () => {
  const kit = new ConsumerKit();
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  it('S05 AS-44: an envelope with a bad aggregate id, a bad payload or a newer contract version is dead-lettered without effect, an unknown type is ignored, and the rest of the batch is applied', async () => {
    const s = await kit.scenario();
    const name = `product-cache-invalidator-${s.id}`;

    @Injectable()
    class StreamInvalidator extends ProductCacheInvalidator {
      readonly name = name;
      readonly topics = [s.topic];
    }
    const app = await s.boot([StreamInvalidator], { imports: [CacheModule] });
    const cache = app.get(CacheService);
    const redis = app.get(RedisService);
    const shopId = uuidv7();
    const [good1, good2, guarded] = [uuidv7(), uuidv7(), uuidv7()];
    const warm = (id: string) =>
      cache.getOrLoad(
        productCacheKey(id),
        () => Promise.resolve({ id, version: 1 }),
        PUBLIC_PRODUCT_ENTRY as never,
      );
    await Promise.all([warm(good1), warm(good2), warm(guarded)]);

    const ok = (id: string, version: number) =>
      ProductUpdated.create(
        id,
        version,
        snapshot(id, shopId, version, ['title']),
      );
    const badId = { ...ok(guarded, 2), aggregateId: 'not-a-uuid' };
    const badPayload = {
      ...ok(guarded, 2),
      payload: { ...snapshot(guarded, shopId, 2), productVersion: 'two' },
    };
    const newer = { ...ok(guarded, 2), version: 2 };
    const unknownType = { ...ok(guarded, 2), type: 'catalog.product_wat' };

    await s.publishRaw(
      [ok(good1, 2), badId, badPayload, newer, unknownType, ok(good2, 3)].map(
        (e) => ({ key: e.aggregateId, value: JSON.stringify(e) }),
      ),
    );

    const dlq = () => readTopic(`${name}.dlq`);
    await waitFor(
      async () =>
        (await dlq()).length === 3 &&
        (await redis.client.exists(productCacheKey(good1))) === 0 &&
        (await redis.client.exists(productCacheKey(good2))) === 0,
      { description: '3 dead letters, the two good events applied' },
    );
    const reasons = (await dlq()).map((l) => l.headers['x-dlq-reason-code']);
    expect(reasons).toHaveLength(3);
    expect(await redis.client.exists(productCacheKey(guarded))).toBe(1);
    expect(
      await redis.client.get(`{${productCacheKey(guarded)}}:min`),
    ).toBeNull();
  });
});

function snapshotView(id: string, shopId: string) {
  return {
    id,
    shopId,
    title: 'Slow',
    description: '',
    brand: 'B',
    category: 'c',
    priceMinor: 100,
    currency: 'USD',
    rating: 0,
    tags: [] as string[],
    inStock: true,
    version: 3,
    viewCount: 0,
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
}
