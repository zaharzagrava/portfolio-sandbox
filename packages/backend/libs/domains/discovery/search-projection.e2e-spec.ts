import { randomUUID } from 'node:crypto';
import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { JobsService } from '@app/infrastructure/jobs';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { ShopQueryService } from '@app/domains/tenancy';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createTopics, deleteTopicsMatching, testKafka } from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import { BackfillShopStateJob } from './application/jobs/backfill-shop-state.job';
import { PurgeTombstonesJob } from './application/jobs/purge-tombstones.job';
import { RefreshPopularityJob } from './application/jobs/refresh-popularity.job';
import { PRODUCT_IMAGE_RESOLVER } from './domain/ports';
import { visibilityFilter } from './domain/visibility-filter';
import { SearchIndexRegistry as SearchIndexRegistryRef } from './infra/search-index-registry';
import { SearchProjectorModule } from './search-projector.module';
import { FakeImageResolver } from './testing/fake-image.resolver';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  galleryEvent,
  newId,
  offboardingCancelled,
  offboardingStarted,
  productDeleted,
  productEvent,
  shopDeleted,
  shopPlanEvent,
  shopStatusEvent,
  snapshot,
  sponsorshipEvent,
} from './testing/search-events';

const DAY = 86_400_000;
const counter = (name: string, labels: Record<string, string>) =>
  MetricsRegistry.value(name, labels) ?? 0;
const stale = (source = 'product') =>
  counter('search_stale_events_ignored_total', { source });
const ignored = (reason: string) =>
  counter('search_ignored_total', { reason });

describe('Search index projection', () => {
  let t: SearchTestApp;
  const images = new FakeImageResolver();
  let shopId: string;

  beforeAll(async () => {
    t = await createSearchApp({
      engineProxy: true,
      overrides: [{ provide: PRODUCT_IMAGE_RESOLVER, useValue: images }],
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    images.notReady.clear();
    images.down = false;
    shopId = newId();
  });

  const send = deliver;
  const product = (over: Partial<ProductSnapshot> & { productId: string }) =>
    snapshot({ shopId, ...over });
  /** The products a public search may return: the shared visibility filter over the live index. */
  const visibleIds = async (extra?: object): Promise<string[]> => {
    await t.refresh();
    const res = await t.es.search({
      index: 'products',
      size: 200,
      _source: false,
      query: { bool: { filter: [...visibilityFilter(), ...(extra ? [extra] : [])] } },
    });
    return res.hits.hits.map((h) => String(h._id)).sort();
  };
  const shopRow = async (productId: string) =>
    (
      await t.rows<{
        productVersion: string;
        deletedAt: Date | null;
        title: string;
        isSandbox: boolean;
        status: string;
      }>(
        `SELECT "productVersion", "deletedAt", "title", "isSandbox", "status" FROM "SearchShopProduct" WHERE "productId" = $1`,
        [productId],
      )
    )[0];

  describe('product events (AS-22 to AS-27)', () => {
    it('S32 AS-22: a created product is searchable after a refresh with its document fields', async () => {
      const p1 = newId();
      const counts = await send(t.app).products(
        productEvent(
          'created',
          product({ productId: p1, title: 'Espresso Machine', productVersion: 1 }),
          t.clock.now(),
        ),
      );
      expect(counts.applied).toBe(1);

      expect(await visibleIds({ match: { title: 'espresso' } })).toEqual([p1]);
      expect(await t.doc(p1)).toMatchObject({
        productId: p1,
        shopId,
        title: 'Espresso Machine',
        productVersion: 1,
        hasProduct: true,
        deleted: false,
        status: 'ACTIVE',
        popularityBucket: 0,
        imageUrl: null,
        sponsored: false,
        embeddingPending: false,
      });
      expect((await t.doc(p1))!.embedding).toHaveLength(64);
      expect(await shopRow(p1)).toMatchObject({ title: 'Espresso Machine' });
    });

    it('S32 AS-23: v3 then v2 keeps v3, v2 then v3 ends the same; the stale one is counted, not dead-lettered', async () => {
      const p1 = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: p1, title: 'Alpha', productVersion: 1 })),
      );
      const before = stale();
      await send(t.app).products(
        productEvent('updated', product({ productId: p1, title: 'Gamma', productVersion: 3 })),
      );
      await expect(
        send(t.app).products(
          productEvent('updated', product({ productId: p1, title: 'Beta', productVersion: 2 })),
        ),
      ).resolves.toMatchObject({ stale: 1 });
      expect(await t.doc(p1)).toMatchObject({ title: 'Gamma', productVersion: 3 });
      expect(stale()).toBe(before + 1);
      expect((await shopRow(p1)).title).toBe('Gamma');

      const p2 = newId();
      await send(t.app).products(
        productEvent('updated', product({ productId: p2, title: 'Beta', productVersion: 2 })),
      );
      await send(t.app).products(
        productEvent('updated', product({ productId: p2, title: 'Gamma', productVersion: 3 })),
      );
      expect(await t.doc(p2)).toMatchObject({ title: 'Gamma', productVersion: 3 });
    });

    it('S32 AS-24: the same event twice, or another event id for the same version, leaves one unchanged document and one write', async () => {
      const p1 = newId();
      const e = productEvent('created', product({ productId: p1, title: 'Once', productVersion: 1 }));
      await send(t.app).products(e);
      const first = await t.es.get({ index: 'products', id: p1 });

      await send(t.app).products(e);
      await send(t.app).products({ ...e, eventId: randomUUID() });

      const again = await t.es.get({ index: 'products', id: p1 });
      expect(again._source).toEqual(first._source);
      expect(again._seq_no).toBe(first._seq_no); // no second write reached the engine
      expect(await t.count({ term: { productId: p1 } })).toBe(1);
      expect(await t.count()).toBe(1);
    });

    it('S32 AS-25: archive hides, a late update stays hidden, restore shows; restore before archive ends ACTIVE at the higher version', async () => {
      const p1 = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: p1, productVersion: 3 })),
      );
      expect(await visibleIds()).toEqual([p1]);

      await send(t.app).products(
        productEvent('archived', product({ productId: p1, status: 'ARCHIVED', productVersion: 4 })),
      );
      expect(await visibleIds()).toEqual([]);
      await send(t.app).products(
        productEvent('updated', product({ productId: p1, title: 'Late', productVersion: 3 })),
      );
      expect(await visibleIds()).toEqual([]);
      await send(t.app).products(
        productEvent('restored', product({ productId: p1, productVersion: 5 })),
      );
      expect(await visibleIds()).toEqual([p1]);

      const p2 = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: p2, productVersion: 3 })),
      );
      await send(t.app).products(
        productEvent('restored', product({ productId: p2, productVersion: 5 })),
      );
      await send(t.app).products(
        productEvent('archived', product({ productId: p2, status: 'ARCHIVED', productVersion: 4 })),
      );
      expect(await t.doc(p2)).toMatchObject({ status: 'ACTIVE', productVersion: 5 });
      expect(await visibleIds()).toEqual([p1, p2].sort());
    });

    it('S32 AS-26: a delete is remembered for 30 days: later older events do not bring the product back, then the purge forgets it', async () => {
      const p1 = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: p1, productVersion: 3 })),
      );
      await send(t.app).products(
        productDeleted(p1, shopId, 6, t.clock.now()),
      );
      expect(await visibleIds()).toEqual([]);
      expect(await t.doc(p1)).toMatchObject({ deleted: true, productVersion: 6, hasProduct: false });
      expect((await shopRow(p1)).deletedAt).not.toBeNull();

      for (const [kind, version] of [['created', 1], ['updated', 5], ['updated', 6]] as const)
        await send(t.app).products(
          productEvent(kind, product({ productId: p1, productVersion: version })),
        );
      expect(await visibleIds()).toEqual([]);
      expect((await t.doc(p1))!.deleted).toBe(true);
      expect((await shopRow(p1)).deletedAt).not.toBeNull();

      const purge = t.app.get(PurgeTombstonesJob, { strict: false });
      t.clock.advance(30 * DAY);
      await purge.purge(); // exactly 30 days: not before the retention is over
      expect(await t.doc(p1)).not.toBeNull();
      expect(await shopRow(p1)).toBeDefined();

      t.clock.advance(1_000);
      await expect(purge.purge()).resolves.toMatchObject({ index: 1, shopTable: 1 });
      expect(await t.doc(p1)).toBeNull();
      expect(await shopRow(p1)).toBeUndefined();
    });

    it('S32 AS-27: a sandbox product is acknowledged and counted, never indexed publicly, but searchable in its shop table', async () => {
      const p1 = newId();
      const before = ignored('sandbox');
      await send(t.app).products(
        productEvent('created', product({ productId: p1, isSandbox: true })),
      );
      expect(ignored('sandbox')).toBe(before + 1);
      expect(await t.doc(p1)).toBeNull();
      expect(await t.count()).toBe(0);
      expect(await shopRow(p1)).toMatchObject({ isSandbox: true });
    });
  });

  describe('shop events (AS-28 to AS-30)', () => {
    it('S32 AS-28: suspend hides the shop (also later products), reinstate shows, a late older event is ignored, an unannounced shop is active, any order converges', async () => {
      const [a, b] = [newId(), newId()];
      await send(t.app).products(
        productEvent('created', product({ productId: a, title: 'A' })),
        productEvent('created', product({ productId: b, title: 'B' })),
      );
      expect(await visibleIds()).toEqual([a, b].sort());

      await send(t.app).shops(shopStatusEvent(shopId, 'SUSPENDED', 7, t.clock.now()));
      expect(await visibleIds()).toEqual([]);

      const later = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: later, title: 'Later' })),
      );
      expect(await visibleIds()).toEqual([]);
      expect(await t.doc(later)).toMatchObject({ shopHidden: true, shopStatus: 'SUSPENDED' });

      await send(t.app).shops(shopStatusEvent(shopId, 'ACTIVE', 8, t.clock.now()));
      expect(await visibleIds()).toEqual([a, b, later].sort());

      const before = stale('shop');
      await expect(
        send(t.app).shops(shopStatusEvent(shopId, 'SUSPENDED', 6, t.clock.now())),
      ).resolves.toMatchObject({ stale: 1 });
      expect(stale('shop')).toBe(before + 1);
      expect(await visibleIds()).toEqual([a, b, later].sort());

      // product event first, shop event second, and the reverse: the same final visibility
      const other = newId();
      const p = newId();
      await send(t.app).products(
        productEvent('created', snapshot({ productId: p, shopId: other })),
      );
      expect(await visibleIds()).toContain(p); // never announced: ACTIVE
      await send(t.app).shops(shopStatusEvent(other, 'SUSPENDED', 2, t.clock.now()));
      expect(await visibleIds()).not.toContain(p);

      const third = newId();
      const q = newId();
      await send(t.app).shops(shopStatusEvent(third, 'SUSPENDED', 2, t.clock.now()));
      await send(t.app).products(
        productEvent('created', snapshot({ productId: q, shopId: third })),
      );
      expect(await visibleIds()).not.toContain(q);
    });

    it('S32 AS-29: offboarding hides, cancelling shows, the later event time wins, deletion purges both stores and later products are ignored', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1 })));
      const t0 = t.clock.now().getTime();

      await send(t.app).shops(offboardingStarted(shopId, new Date(t0 + 1_000)));
      expect(await visibleIds()).toEqual([]);
      await send(t.app).shops(offboardingCancelled(shopId, new Date(t0 + 2_000)));
      expect(await visibleIds()).toEqual([p1]);

      // reordered: the cancel (later) arrives first, the start (earlier) afterwards
      const s2 = newId();
      const p2 = newId();
      await send(t.app).products(
        productEvent('created', snapshot({ productId: p2, shopId: s2 })),
      );
      await send(t.app).shops(offboardingCancelled(s2, new Date(t0 + 20_000)));
      await send(t.app).shops(offboardingStarted(s2, new Date(t0 + 10_000)));
      expect(await visibleIds()).toContain(p2);

      const before = ignored('shop_deleted');
      await send(t.app).shops(shopDeleted(shopId, new Date(t0 + 30_000)));
      expect(await t.doc(p1)).toBeNull();
      expect(await shopRow(p1)).toBeUndefined();

      const late = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: late })),
      );
      expect(ignored('shop_deleted')).toBe(before + 1);
      expect(await t.doc(late)).toBeNull();
      expect(await shopRow(late)).toBeUndefined();

      await expect(
        send(t.app).shops(shopDeleted(shopId, new Date(t0 + 31_000))),
      ).resolves.toBeDefined(); // a repeat changes nothing
      expect(await t.doc(p1)).toBeNull();
    });

    it('S32 AS-30: a plan change boosts the shop, an older shopVersion is ignored, an unknown plan is refused with no change', async () => {
      const [pro, starter] = [newId(), newId()];
      const other = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: pro, title: 'Same' })),
        productEvent('created', snapshot({ productId: starter, shopId: other, title: 'Same' })),
      );
      const neutral = (await t.doc(pro))!.browseScore;

      await send(t.app).shops(shopPlanEvent(shopId, 'PRO', 4, t.clock.now()));
      const boosted = await t.doc(pro);
      expect(boosted).toMatchObject({ shopTier: 'PRO', shopStateVersion: 4 });
      expect(boosted!.browseScore).toBeGreaterThan(neutral);
      expect(boosted!.browseScore).toBeGreaterThan((await t.doc(starter))!.browseScore);

      await send(t.app).shops(shopPlanEvent(shopId, 'STARTER', 3, t.clock.now()));
      expect(await t.doc(pro)).toMatchObject({ shopTier: 'PRO' });

      await expect(
        send(t.app).shops(shopPlanEvent(shopId, 'GOLD', 9, t.clock.now())),
      ).rejects.toBeInstanceOf(PermanentError);
      expect(await t.doc(pro)).toMatchObject({ shopTier: 'PRO', shopStateVersion: 4 });
    });
  });

  describe('signals (AS-31, AS-32)', () => {
    it('S32 AS-31: sponsorship sets the flag and boosts, a late false is ignored, it never reveals a hidden product, an early one is kept', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1 })));
      const plain = (await t.doc(p1))!.browseScore;

      await send(t.app).sponsorship(sponsorshipEvent(p1, shopId, true, 2, t.clock.now()));
      const sponsored = await t.doc(p1);
      expect(sponsored).toMatchObject({ sponsored: true, sponsorshipVersion: 2 });
      expect(sponsored!.browseScore).toBeGreaterThan(plain);

      await expect(
        send(t.app).sponsorship(sponsorshipEvent(p1, shopId, false, 1, t.clock.now())),
      ).resolves.toMatchObject({ stale: 1 });
      expect((await t.doc(p1))!.sponsored).toBe(true);

      const hidden = newId();
      await send(t.app).products(
        productEvent('created', product({ productId: hidden, status: 'ARCHIVED' })),
      );
      await send(t.app).sponsorship(sponsorshipEvent(hidden, shopId, true, 1, t.clock.now()));
      expect(await visibleIds()).toEqual([p1]);

      const early = newId();
      await send(t.app).sponsorship(sponsorshipEvent(early, shopId, true, 1, t.clock.now()));
      expect(await visibleIds()).not.toContain(early); // signal only: not a product yet
      await send(t.app).products(productEvent('created', product({ productId: early })));
      expect(await visibleIds()).toContain(early);
      expect((await t.doc(early))!.sponsored).toBe(true);
    });

    it('S32 AS-32: the first media becomes the thumbnail, an empty list clears it, older versions are ignored, image and product events do not disturb each other', async () => {
      const [p1, m1, m2] = [newId(), newId(), newId()];
      await send(t.app).products(productEvent('created', product({ productId: p1, title: 'Lamp' })));

      await send(t.app).gallery(galleryEvent(p1, shopId, [m1, m2], 2, t.clock.now()));
      expect((await t.doc(p1))!.imageUrl).toBe(FakeImageResolver.thumb(m1));
      await send(t.app).gallery(galleryEvent(p1, shopId, [], 3, t.clock.now()));
      expect((await t.doc(p1))!.imageUrl).toBeNull();
      await send(t.app).gallery(galleryEvent(p1, shopId, [m2], 2, t.clock.now()));
      expect((await t.doc(p1))!.imageUrl).toBeNull();

      await send(t.app).gallery(galleryEvent(p1, shopId, [m1], 4, t.clock.now()));
      await send(t.app).products(
        productEvent('updated', product({ productId: p1, title: 'Lamp XL', productVersion: 2 })),
      );
      expect(await t.doc(p1)).toMatchObject({
        imageUrl: FakeImageResolver.thumb(m1),
        title: 'Lamp XL',
      });

      const p2 = newId();
      await send(t.app).gallery(galleryEvent(p2, shopId, [m1], 1, t.clock.now()));
      expect(await visibleIds()).not.toContain(p2);
      await send(t.app).products(productEvent('created', product({ productId: p2 })));
      expect((await t.doc(p2))!.imageUrl).toBe(FakeImageResolver.thumb(m1));

      images.notReady.add(m2);
      await send(t.app).gallery(galleryEvent(p2, shopId, [m2], 2, t.clock.now()));
      expect((await t.doc(p2))!.imageUrl).toBeNull(); // not ready: no image yet
    });
  });

  describe('bad messages and outages (AS-33 to AS-36)', () => {
    it('S32 AS-33: each invalid class is refused with no change and the next valid message is processed; an unknown type is acknowledged', async () => {
      const p1 = newId();
      const valid = productEvent('created', product({ productId: p1 }));
      const bad: EventEnvelope[] = [
        productEvent('updated', product({ productId: p1, productVersion: 2 })),
      ].flatMap((e) => {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const { productVersion, ...withoutVersion } = payload;
        void productVersion;
        return [
          { ...e, payload: withoutVersion },
          { ...e, payload: { ...payload, priceMinor: -5 } },
          { ...e, payload: { ...payload, currency: 'usd' } },
          { ...e, payload: { ...payload, productId: 'not-a-uuid' } },
          { ...e, aggregateId: 'not-a-uuid' },
          { ...e, version: 2 },
        ];
      });
      for (const envelope of bad) {
        await expect(send(t.app).products(envelope)).rejects.toBeInstanceOf(PermanentError);
        expect(await t.count()).toBe(0);
        expect(await shopRow(p1)).toBeUndefined();
      }
      await send(t.app).products(valid);
      expect(await visibleIds()).toEqual([p1]);

      const unknown = ignored('unknown_type');
      await send(t.app).products({ ...valid, type: 'catalog.product_changed' });
      expect(ignored('unknown_type')).toBe(unknown + 1);
    });

    it('S32 AS-34: thirty updates in one batch reach the engine as one write carrying the newest version', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1, productVersion: 1 })));
      const spy = jest.spyOn(t.engine, 'bulk');
      const batch = Array.from({ length: 30 }, (_, i) =>
        productEvent('updated', product({ productId: p1, title: `T${i + 2}`, productVersion: i + 2 })),
      );
      await send(t.app).products(...batch);

      const writes = spy.mock.calls
        .flatMap(([ops]) => ops as object[])
        .filter((op) => (op as { index?: { _id: string } }).index?._id === p1);
      expect(writes).toHaveLength(1);
      expect(await t.doc(p1)).toMatchObject({ productVersion: 31, title: 'T31' });
      spy.mockRestore();
    });

    it('S32 AS-35: an unavailable engine fails the batch as transient (not acknowledged), recovery loses nothing, a permanent rejection fails only its document', async () => {
      const p1 = newId();
      const e = productEvent('created', product({ productId: p1, title: 'Survivor' }));
      t.proxy!.mode = 'refuse';
      await expect(send(t.app).products(e)).rejects.toBeInstanceOf(TransientError);
      t.proxy!.mode = 'pass';
      t.app.get(SearchIndexRegistryRef, { strict: false }).invalidate();
      await send(t.app).products(e); // the framework redelivers the same batch
      expect(await visibleIds()).toEqual([p1]);

      const [good, badId] = [newId(), newId()];
      await expect(
        send(t.app).products(
          productEvent('created', product({ productId: good, title: 'Fine' })),
          productEvent('created', product({ productId: badId, createdAt: 'not-a-date' })),
        ),
      ).rejects.toBeInstanceOf(PermanentError);
      expect(await t.doc(good)).not.toBeNull(); // the rest of the batch was applied
      expect(await t.doc(badId)).toBeNull();
    });

    it('S32 AS-36: a change is searchable and in the shop table at once, within the freshness bound, and the lag is measured', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1, priceMinor: 1_000, quantity: 5 })));
      const lag = MetricsRegistry.histogramValue('search_projection_lag_seconds', { source: 'product' })?.count ?? 0;
      const occurredAt = new Date();
      const started = Date.now();
      await send(t.app).products(
        productEvent('updated', product({ productId: p1, priceMinor: 2_500, quantity: 0, inStock: false, productVersion: 2 }), occurredAt),
      );
      expect(await t.count({ term: { priceMinor: 2_500 } })).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await t.doc(p1)).toMatchObject({ priceMinor: 2_500, inStock: false });
      expect(await shopRow(p1)).toMatchObject({ productVersion: '2' });
      expect(
        MetricsRegistry.histogramValue('search_projection_lag_seconds', { source: 'product' })!.count,
      ).toBe(lag + 1);
    });
  });

  describe('jobs (AS-37, AS-38)', () => {
    it('S32 AS-37: popularity is a damped bucket of the last 30 days of clicks, only changed buckets are written, product updates keep it, two runs write once', async () => {
      const clickhouse = t.app.get(ClickHouseService);
      await applyClickHouseDdl(clickhouse, '030_search_queries.sql', '110_search_measurement.sql');
      await clickhouse.getClient().command({ query: 'TRUNCATE TABLE search_clicks' });
      const [p1, p2, p3] = [newId(), newId(), newId()];
      for (const id of [p1, p2, p3])
        await send(t.app).products(productEvent('created', product({ productId: id, title: id.slice(0, 6) })));
      const now = t.clock.now();
      const click = (productId: string, i: number, ageDays: number) => ({
        event_id: randomUUID(),
        query: 'q',
        product_id: productId,
        position: i % 10,
        ts: new Date(now.getTime() - ageDays * DAY).toISOString().replace('T', ' ').replace('Z', ''),
      });
      await clickhouse.getClient().insert({
        table: 'search_clicks',
        format: 'JSONEachRow',
        values: [
          ...Array.from({ length: 120 }, (_, i) => click(p1, i, 1)),
          ...Array.from({ length: 2 }, (_, i) => click(p2, i, 2)),
          ...Array.from({ length: 500 }, (_, i) => click(p3, i, 45)), // older than the window
        ],
      });

      const job = t.app.get(RefreshPopularityJob, { strict: false });
      const before = await t.doc(p1);
      const [r1, r2] = await Promise.all([job.refresh(), job.refresh()]);
      expect(r1.changed + r2.changed).toBe(1); // p1 only: p2 stays 0, p3 is outside the window

      const [d1, d2, d3] = [await t.doc(p1), await t.doc(p2), await t.doc(p3)];
      expect(d1!.popularityBucket).toBeGreaterThan(d2!.popularityBucket);
      expect(d1!.popularityBucket).toBeGreaterThan(0);
      expect(d3!.popularityBucket).toBe(0);
      const popularityOnly = { popularityBucket: 0, popularityAt: null, browseBase: 0, browseScore: 0 };
      expect({ ...d1, ...popularityOnly }).toEqual({ ...before, ...popularityOnly }); // only the popularity fields (and the scores derived from them) moved
      expect(d1!.productVersion).toBe(1);
      expect(d1!.browseScore).toBeGreaterThan(before!.browseScore);

      await expect(job.refresh()).resolves.toMatchObject({ changed: 0 });
      await send(t.app).products(
        productEvent('updated', product({ productId: p1, title: 'Renamed', productVersion: 2 })),
      );
      expect(await t.doc(p1)).toMatchObject({ title: 'Renamed', popularityBucket: d1!.popularityBucket });
    });

    it('S32 AS-38: the shop-state backfill asks tenancy for at most 500 ids, stores state under the version guard, hides suspended shops, leaves unknown ones active, resumes by cursor and a rerun changes nothing', async () => {
      const suspended = await createShop(t.app, null, { status: 'SUSPENDED', plan: 'PRO' });
      const active = await createShop(t.app, null, { plan: 'STARTER' });
      const unknown = newId();
      const ids: Record<string, string> = {};
      for (const [name, sid] of [['suspended', suspended.id], ['active', active.id], ['unknown', unknown]] as const) {
        ids[name] = newId();
        await send(t.app).products(
          productEvent('created', snapshot({ productId: ids[name], shopId: sid })),
        );
      }
      expect(await visibleIds()).toHaveLength(3);

      const tenancy = t.app.get(ShopQueryService);
      const spy = jest.spyOn(tenancy, 'getShopsByIds');
      const job = t.app.get(BackfillShopStateJob, { strict: false });
      const first = await job.run({});
      expect(first).toMatchObject({ shops: 3, applied: 2 });
      expect(Math.max(...spy.mock.calls.map(([x]) => x.length))).toBeLessThanOrEqual(500);

      expect(await visibleIds()).toEqual([ids.active, ids.unknown].sort());
      expect(await t.doc(ids.suspended)).toMatchObject({ shopHidden: true, shopTier: 'PRO', shopStateVersion: 1 });
      const rows = await t.rows<{ shopId: string; shopVersion: string }>(
        `SELECT "shopId", "shopVersion" FROM "SearchShopState"`,
      );
      expect(rows.map((r) => r.shopId).sort()).toEqual([active.id, suspended.id].sort());

      await expect(job.run({})).resolves.toMatchObject({ applied: 0 }); // rerun: nothing changes
      const after = [...new Set([suspended.id, active.id, unknown])].sort()[0];
      await expect(job.run({ cursor: [suspended.id, active.id, unknown].sort().at(-1)! })).resolves.toMatchObject({ shops: 0 });
      void after;
      spy.mockRestore();
    });

    it('S32 AS-38: a full page of 500 shops enqueues the next page with its cursor', async () => {
      const operations = Array.from({ length: 501 }, (_, i) => {
        const sid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        return [
          { index: { _index: 'products', _id: newId() } },
          { productId: newId(), shopId: sid, hasProduct: false, deleted: false },
        ];
      }).flat();
      await t.es.bulk({ operations, refresh: true });
      const job = t.app.get(BackfillShopStateJob, { strict: false });
      const spy = jest.spyOn(t.app.get(ShopQueryService), 'getShopsByIds');
      await expect(job.run({})).resolves.toMatchObject({ shops: 500 });
      expect(spy.mock.calls[0][0]).toHaveLength(500);
      const probe = new JobsTestProbe(t.sequelize);
      expect(await probe.find('search.backfill-shop-state')).toHaveLength(1);
      void JobsService;
    });
  });

  describe('every consumer: duplicates and invalid payloads (VII.4)', () => {
    it('S32 AS-24: a duplicate delivery to the shop-state, media and sponsorship consumers changes nothing', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1 })));
      const events = {
        shops: shopStatusEvent(shopId, 'SUSPENDED', 2, t.clock.now()),
        gallery: galleryEvent(p1, shopId, [newId()], 1, t.clock.now()),
        sponsorship: sponsorshipEvent(p1, shopId, true, 1, t.clock.now()),
      };
      await send(t.app).shops(events.shops);
      await send(t.app).gallery(events.gallery);
      await send(t.app).sponsorship(events.sponsorship);
      const once = (await t.es.get({ index: 'products', id: p1 }))._source;
      await send(t.app).shops(events.shops);
      await send(t.app).gallery(events.gallery);
      await send(t.app).sponsorship(events.sponsorship);
      expect((await t.es.get({ index: 'products', id: p1 }))._source).toEqual(once);
    });

    it('S32 AS-33: an invalid payload to the shop-state, media and sponsorship consumers is refused with no effect', async () => {
      const p1 = newId();
      await send(t.app).products(productEvent('created', product({ productId: p1 })));
      const before = (await t.es.get({ index: 'products', id: p1 }))._source;
      const e = shopStatusEvent(shopId, 'SUSPENDED', 2, t.clock.now());
      await expect(send(t.app).shops({ ...e, payload: { ...(e.payload as object), shopId: 'nope' } })).rejects.toBeInstanceOf(PermanentError);
      await expect(send(t.app).shops({ ...e, version: 2 })).rejects.toBeInstanceOf(PermanentError);
      const g = galleryEvent(p1, shopId, [], 1, t.clock.now());
      await expect(send(t.app).gallery({ ...g, payload: { ...(g.payload as object), galleryVersion: -1 } })).rejects.toBeInstanceOf(PermanentError);
      const s = sponsorshipEvent(p1, shopId, true, 1, t.clock.now());
      await expect(send(t.app).sponsorship({ ...s, payload: { ...(s.payload as object), sponsored: 'yes' } })).rejects.toBeInstanceOf(PermanentError);
      expect((await t.es.get({ index: 'products', id: p1 }))._source).toEqual(before);
      expect(await t.rows(`SELECT 1 FROM "SearchShopState"`)).toHaveLength(0);
    });
  });
});

describe('Search index projection through the consumer framework', () => {
  let t: SearchTestApp;

  beforeAll(async () => {
    await deleteTopicsMatching(/^(products\.events|search-indexer\.dlq)$/);
    await createTopics([
      { topic: 'products.events' },
      { topic: 'search-indexer.dlq' },
    ]);
    t = await createSearchApp({
      extraImports: [
        ProjectionsModule.forProjectors(SearchProjectorModule.projectors, [
          SearchProjectorModule,
        ]),
      ],
    });
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetSearch());

  it('S32 AS-22: an event on the log becomes searchable and the consumer group commits its offset', async () => {
    const p1 = newId();
    const e = productEvent('created', snapshot({ productId: p1, shopId: newId(), title: 'Via Kafka' }));
    const producer = testKafka().producer();
    await producer.connect();
    await producer.send({ topic: 'products.events', messages: [{ key: p1, value: JSON.stringify(e) }] });
    await producer.disconnect();

    await waitFor(async () => (await t.doc(p1)) !== null, { description: 'document indexed' });
    expect(await t.doc(p1)).toMatchObject({ title: 'Via Kafka', productVersion: 1 });
    const admin = testKafka().admin();
    await admin.connect();
    const [offsets] = await waitFor(
      async () => {
        const [o] = await admin.fetchOffsets({ groupId: 'search-indexer', topics: ['products.events'] });
        return o.partitions.some((x) => Number(x.offset) >= 1) ? [o] : null;
      },
      { description: 'offset committed' },
    );
    await admin.disconnect();
    expect(offsets.partitions.some((x) => Number(x.offset) >= 1)).toBe(true);
  });

  it('S32 AS-33: a poison message goes to the dead-letter topic and the next message in the partition is processed', async () => {
    const [bad, good] = [newId(), newId()];
    const s = snapshot({ productId: bad, shopId: newId() });
    const poison = { ...productEvent('created', s), payload: { ...s, priceMinor: -5 } };
    const valid = productEvent('created', snapshot({ productId: good, shopId: newId(), title: 'After poison' }));
    const producer = testKafka().producer();
    await producer.connect();
    await producer.send({
      topic: 'products.events',
      messages: [
        { key: bad, value: JSON.stringify(poison), partition: 0 },
        { key: good, value: JSON.stringify(valid), partition: 0 },
      ],
    });
    await producer.disconnect();

    await waitFor(async () => (await t.doc(good)) !== null, { description: 'valid message processed', timeoutMs: 30_000 });
    expect(await t.doc(bad)).toBeNull();
    const reader = testKafka().consumer({ groupId: `raw-${randomUUID()}` });
    await reader.connect();
    await reader.subscribe({ topic: 'search-indexer.dlq', fromBeginning: true });
    const seen: string[] = [];
    await reader.run({ eachMessage: async ({ message }) => void seen.push(message.key?.toString() ?? '') });
    await waitFor(async () => seen.includes(bad), { description: 'dead letter written', timeoutMs: 30_000 });
    await reader.disconnect();
  });
});
