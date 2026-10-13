import {
  pickupClustersResponseSchema,
  pickupNearSearchResponseSchema,
  pickupPointsNearResponseSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { PICKUP_BROWSE_TIMEOUT_MS } from './infra/pickup-browse.reader';
import {
  ALEX,
  createPickupApp,
  KREUZBERG,
  MITTE,
  SPANDAU,
  type PickupTestApp,
  type PickupWorld,
} from './testing/pickup-fixtures';

/** About 6 km east of ALEX. */
const FAR6 = { lat: 52.5219, lng: 13.5032 };

describe('Available near me: search, browse, pagination, limits and degradation', () => {
  let t: PickupTestApp;
  let w: PickupWorld;
  let kreuzberg: { id: string };
  let mitte: { id: string };

  beforeAll(async () => {
    t = await createPickupApp({
      proxies: { redis: true, search: true },
      overrides: [{ provide: PICKUP_BROWSE_TIMEOUT_MS, useValue: 300 }],
    });
  });
  afterAll(() => t.close());
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
    await t.activateShop(w.s1.id);
    await t.activateShop(w.s2.id);
    kreuzberg = await t.createPoint(w.u1, w.s1.id, {
      ...KREUZBERG,
      name: 'Kreuzberg',
    });
    mitte = await t.createPoint(w.u1, w.s1.id, { ...MITTE, name: 'Mitte' });
  });

  const stock = (
    pointId: string,
    productId: string,
    quantity: number,
    user = w.u1,
    shopId = w.s1.id,
  ) => t.setStock(user, shopId, pointId, productId, quantity);
  const search = (query: Record<string, unknown> = {}) =>
    t
      .http()
      .get('/api/search/near')
      .query({ lat: ALEX.lat, lng: ALEX.lng, ...query });
  const browse = (query: Record<string, unknown> = {}) =>
    t
      .http()
      .get('/api/pickup-points/near')
      .query({ lat: ALEX.lat, lng: ALEX.lng, ...query });
  const clusters = (query: Record<string, unknown> = {}) =>
    t
      .http()
      .get('/api/pickup-points/clusters')
      .query({ bbox: '52.7,13.1,52.3,13.7', zoom: '10', ...query });
  const items = (body: { items: { productId: string }[] }) =>
    body.items.map((i) => i.productId);
  const metres = async (lat: number, lng: number) =>
    (
      await t.sql<{ m: number }>(
        `SELECT ST_Distance(ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, ST_SetSRID(ST_MakePoint(:alng, :alat), 4326)::geography) AS m`,
        { lat, lng, alat: ALEX.lat, alng: ALEX.lng },
      )
    )[0].m;
  /** A coordinate `d` metres due east of ALEX, on the spheroid. */
  const eastOf = async (d: number) =>
    (
      await t.sql<{ lat: number; lng: number }>(
        `SELECT ST_Y(g) AS lat, ST_X(g) AS lng FROM (SELECT ST_Project(ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :d, radians(90))::geometry AS g) s`,
        { lat: ALEX.lat, lng: ALEX.lng, d },
      )
    )[0];

  describe('US1 - search', () => {
    it('S19 AS-01: product A in stock 4 at a point 3 km away and 0 at another: radius 5 finds it with the nearest point, radius 2 finds nothing, radius 20 still one item', async () => {
      const a = await t.product(w.s1.id, { title: 'AirPods Pro 3' });
      const spandau = await t.createPoint(w.u1, w.s1.id, {
        ...SPANDAU,
        name: 'Spandau',
      });
      await stock(kreuzberg.id, a.id, 4);
      await stock(spandau.id, a.id, 0);
      await t.consume();

      const res = await search({ q: 'airpods', radiusKm: '5' }).expect(200);

      const body = pickupNearSearchResponseSchema.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        productId: a.id,
        title: 'AirPods Pro 3',
        nearest: {
          pickupPointId: kreuzberg.id,
          name: 'Kreuzberg',
          quantity: 4,
        },
      });
      const expected = await metres(KREUZBERG.lat, KREUZBERG.lng);
      expect(body.items[0].nearest.distanceM).toBeGreaterThan(2000);
      expect(Math.abs(body.items[0].nearest.distanceM - expected)).toBeLessThan(
        expected * 0.01,
      );
      expect(
        (await search({ q: 'airpods', radiusKm: '2' }).expect(200)).body.items,
      ).toEqual([]);
      expect(
        items(
          (await search({ q: 'airpods', radiusKm: '20' }).expect(200)).body,
        ),
      ).toEqual([a.id]);
    });

    it('S19 AS-02: a product in stock at two points appears once with the nearest; relevance comes before distance; a misspelling still finds it; without q the order is distance then productId', async () => {
      const a = await t.product(w.s1.id, {
        title:
          'Wireless noise cancelling premium AirPods Pro 3 headphones with charging case',
      });
      const b = await t.product(w.s1.id, { title: 'AirPods' });
      const c = await t.product(w.s1.id, { title: 'AirPods' });
      await stock(kreuzberg.id, a.id, 3);
      await stock(mitte.id, a.id, 3);
      await stock(kreuzberg.id, b.id, 2);
      await stock(mitte.id, c.id, 2);
      await t.consume();

      const withQuery = (
        await search({ q: 'airpods', radiusKm: '10' }).expect(200)
      ).body;
      expect(items(withQuery)).toEqual([c.id, b.id, a.id]);
      expect(
        withQuery.items.find((i: { productId: string }) => i.productId === a.id)
          .nearest.pickupPointId,
      ).toBe(mitte.id);
      expect(
        items(
          (await search({ q: 'airpdos', radiusKm: '10' }).expect(200)).body,
        ).sort(),
      ).toEqual([a.id, b.id, c.id].sort());

      const without = (await search({ radiusKm: '10' }).expect(200)).body;
      const nearMitte = [a.id, c.id].sort();
      expect(items(without)).toEqual([...nearMitte, b.id]);
    });

    it('S19 AS-03: two points 120 m apart on both sides of a cell edge at every zoom are both found by a 1 km radius; a 0.1 km radius finds only the one within 100 m', async () => {
      // the prime meridian is a tile edge at every zoom from 1 to 20
      const london = { lat: 51.5, lng: 0 };
      const east = await t.createPoint(w.u1, w.s1.id, {
        lat: 51.5,
        lng: 0.0001,
        name: 'East',
      });
      const west = await t.createPoint(w.u1, w.s1.id, {
        lat: 51.5,
        lng: -0.0016,
        name: 'West',
      });
      const [a, b, both] = await Promise.all([
        t.product(w.s1.id),
        t.product(w.s1.id),
        t.product(w.s1.id),
      ]);
      await stock(east.id, a.id, 1);
      await stock(west.id, b.id, 1);
      await stock(east.id, both.id, 1);
      await stock(west.id, both.id, 1);
      await t.consume();
      const at = (radiusKm: string) =>
        t
          .http()
          .get('/api/search/near')
          .query({ ...london, radiusKm });

      const wide = (await at('1').expect(200)).body;
      expect(items(wide).sort()).toEqual([a.id, b.id, both.id].sort());
      expect(
        wide.items.find((i: { productId: string }) => i.productId === both.id)
          .nearest.pickupPointId,
      ).toBe(east.id);
      const narrow = (await at('0.1').expect(200)).body;
      expect(items(narrow).sort()).toEqual([a.id, both.id].sort());
    });
  });

  describe('US1 - validation', () => {
    it.each([
      ['lat missing', { lat: undefined }, 'lat'],
      ['lat not a number', { lat: 'north' }, 'lat'],
      ['lat above 90', { lat: '90.5' }, 'lat'],
      ['lng missing', { lng: undefined }, 'lng'],
      ['lng not a number', { lng: 'east' }, 'lng'],
      ['lng below -180', { lng: '-181' }, 'lng'],
      ['radiusKm not a number', { radiusKm: 'far' }, 'radiusKm'],
      ['radiusKm below 0.1', { radiusKm: '0.09' }, 'radiusKm'],
      ['radiusKm above 50', { radiusKm: '50.5' }, 'radiusKm'],
      ['q over 100 characters', { q: 'x'.repeat(101) }, 'q'],
      ['limit fractional', { limit: '2.5' }, 'limit'],
      ['limit zero', { limit: '0' }, 'limit'],
      ['limit above 50', { limit: '51' }, 'limit'],
      ['a malformed cursor', { cursor: 'abc' }, 'cursor'],
      ['an unknown parameter', { colour: 'red' }, 'colour'],
    ])(
      'S19 AS-04: %s answers 400 validation_failed naming the field, and the index is not queried',
      async (_name, change, field) => {
        const engine = jest.spyOn(t.app.get(SearchEngineClient), 'search');
        const res = await search(change).expect(400);

        expect(res.body.code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        expect(engine).not.toHaveBeenCalled();
      },
    );

    it('S19 AS-04: a blank q is treated as absent; the defaults are radius 5 and limit 20', async () => {
      const near = await t.product(w.s1.id, { title: 'Near item' });
      const far = await t.product(w.s1.id, { title: 'Far item' });
      const farPoint = await t.createPoint(w.u1, w.s1.id, {
        ...FAR6,
        name: 'Far',
      });
      await stock(kreuzberg.id, near.id, 1);
      await stock(farPoint.id, far.id, 1);
      const many = await Promise.all(
        Array.from({ length: 22 }, () => t.product(w.s1.id)),
      );
      for (const p of many) await stock(mitte.id, p.id, 1);
      await t.consume();

      const blank = (await search({ q: '   ' }).expect(200)).body;
      const absent = (await search().expect(200)).body;

      expect(blank).toEqual(absent);
      expect(blank.items).toHaveLength(20);
      expect(blank.nextCursor).not.toBeNull();
      expect(
        items((await search({ limit: '50' }).expect(200)).body),
      ).not.toContain(far.id);
      expect(
        items((await search({ radiusKm: '7', limit: '50' }).expect(200)).body),
      ).toContain(far.id);
    });
  });

  describe('US1 - pagination', () => {
    it('S19 AS-05: 45 products at distinct and at equal distances: pages of 20, 20 and 5 in the order of one unpaged request; equal distances break on productId; the cursor is opaque and bound to its query', async () => {
      const shared = await t.createPoint(w.u1, w.s1.id, {
        ...ALEX,
        lat: ALEX.lat + 0.0001,
        name: 'Shared',
      });
      const lined = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          t.createPoint(w.u1, w.s1.id, {
            lat: ALEX.lat + 0.0009 * (i + 2),
            lng: ALEX.lng,
            name: `L${i}`,
          }),
        ),
      );
      const products = await Promise.all(
        Array.from({ length: 45 }, (_, i) =>
          t.product(w.s1.id, { title: `Item ${i}` }),
        ),
      );
      for (const [i, p] of products.entries())
        await stock(i < 15 ? shared.id : lined[i - 15].id, p.id, 1);
      await t.consume();

      const unpaged = (await search({ q: 'item', limit: '50' }).expect(200))
        .body;
      expect(unpaged.items).toHaveLength(45);
      expect(unpaged.nextCursor).toBeNull();

      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const res = await search({
          q: 'item',
          limit: '20',
          ...(cursor ? { cursor } : {}),
        }).expect(200);
        pages.push(items(res.body));
        cursor = res.body.nextCursor ?? undefined;
        if (cursor) {
          expect(cursor).not.toMatch(/^\d+$/);
          expect(Buffer.from(cursor, 'base64url').toString()).not.toMatch(
            /^\d+$/,
          );
        }
      } while (cursor);

      expect(pages.map((p) => p.length)).toEqual([20, 20, 5]);
      expect(pages.flat()).toEqual(items(unpaged));
      expect(new Set(pages.flat()).size).toBe(45);
      const sharedIds = unpaged.items
        .filter(
          (i: { nearest: { pickupPointId: string } }) =>
            i.nearest.pickupPointId === shared.id,
        )
        .map((i: { productId: string }) => i.productId);
      expect(sharedIds).toHaveLength(15);
      expect(sharedIds).toEqual([...sharedIds].sort());

      const first = (await search({ q: 'item', limit: '20' }).expect(200)).body;
      const reused = await search({
        q: 'other',
        limit: '20',
        cursor: first.nextCursor,
      }).expect(400);
      expect(reused.body.code).toBe('validation_failed');
      expect(
        reused.body.errors.map((e: { field: string }) => e.field),
      ).toContain('cursor');
      await search({
        q: 'item',
        limit: '20',
        radiusKm: '4',
        cursor: first.nextCursor,
      }).expect(400);
    });
  });

  describe('US1 - visibility', () => {
    it('S19 AS-06: archived, sandbox, inactive-point and suspended-shop offers are invisible in search, browse and clusters, and come back when restored, reactivated and reinstated', async () => {
      const [archived, sandbox, atInactive, ofSuspended, normal] =
        await Promise.all([
          t.product(w.s1.id, { title: 'Archived', status: 'ARCHIVED' }),
          t.product(w.s1.id, { title: 'Sandbox', isSandbox: true }),
          t.product(w.s1.id, { title: 'AtInactive' }),
          t.product(w.s2.id, { title: 'OfSuspended' }),
          t.product(w.s1.id, { title: 'Normal' }),
        ]);
      const s2Point = await t.createPoint(w.u2, w.s2.id, {
        ...SPANDAU,
        name: 'S2',
      });
      await stock(kreuzberg.id, archived.id, 1);
      await stock(kreuzberg.id, sandbox.id, 1);
      await stock(kreuzberg.id, normal.id, 1);
      await stock(mitte.id, atInactive.id, 1);
      await stock(s2Point.id, ofSuspended.id, 1, w.u2, w.s2.id);
      await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${mitte.id}`)
        .send({ active: false })
        .expect(200);
      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s2.id, 'SUSPENDED', 2),
      ]);
      await t.consume();

      expect(
        items((await search({ radiusKm: '50', limit: '50' }).expect(200)).body),
      ).toEqual([normal.id]);
      for (const hidden of [archived, sandbox, atInactive, ofSuspended])
        expect(
          (await browse({ radiusKm: '50', productId: hidden.id }).expect(200))
            .body.items,
        ).toEqual([]);
      expect(
        (
          await browse({ radiusKm: '50', productId: normal.id }).expect(200)
        ).body.items.map((i: { id: string }) => i.id),
      ).toEqual([kreuzberg.id]);
      const cells = (await clusters().expect(200)).body.cells as {
        offers: number;
      }[];
      expect(cells.reduce((sum, c) => sum + c.offers, 0)).toBe(1);

      await t.feed(t.projectors.product, [
        t.events.productSnapshot('restored', archived, 2, { status: 'ACTIVE' }),
      ]);
      await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${mitte.id}`)
        .send({ active: true })
        .expect(200);
      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s2.id, 'ACTIVE', 3),
      ]);
      await t.consume();

      expect(
        items(
          (await search({ radiusKm: '50', limit: '50' }).expect(200)).body,
        ).sort(),
      ).toEqual([archived.id, atInactive.id, ofSuspended.id, normal.id].sort());
      expect(
        (
          await browse({ radiusKm: '50', productId: ofSuspended.id }).expect(
            200,
          )
        ).body.items,
      ).toHaveLength(1);
      const after = (await clusters().expect(200)).body.cells as {
        offers: number;
      }[];
      expect(after.reduce((sum, c) => sum + c.offers, 0)).toBe(4);
    });
  });

  describe('US1 - contract and access', () => {
    it('S19 AS-07: anonymous callers get 200 on the three reads; the bodies parse with the contract and hold no field outside it', async () => {
      const a = await t.product(w.s1.id, {
        title: 'AirPods Pro 3',
        category: 'audio',
        priceMinor: 24_900,
      });
      await stock(kreuzberg.id, a.id, 4);
      await t.consume();

      const s = await search({ radiusKm: '10' }).expect(200);
      const b = await browse({ radiusKm: '10', productId: a.id }).expect(200);
      const c = await clusters().expect(200);

      const searchBody = pickupNearSearchResponseSchema.parse(s.body);
      expect(Object.keys(s.body).sort()).toEqual(['items', 'nextCursor']);
      expect(Object.keys(searchBody.items[0]).sort()).toEqual([
        'category',
        'currency',
        'nearest',
        'priceMinor',
        'productId',
        'title',
      ]);
      expect(Object.keys(searchBody.items[0].nearest).sort()).toEqual([
        'distanceM',
        'name',
        'pickupPointId',
        'quantity',
      ]);
      expect(searchBody.items[0]).toMatchObject({
        priceMinor: 24_900,
        currency: 'USD',
      });
      const browseBody = pickupPointsNearResponseSchema.parse(b.body);
      expect(Object.keys(browseBody.items[0]).sort()).toEqual([
        'address',
        'distanceM',
        'id',
        'lat',
        'lng',
        'name',
        'openingHours',
        'quantity',
        'shopId',
      ]);
      const clusterBody = pickupClustersResponseSchema.parse(c.body);
      expect(Object.keys(c.body).sort()).toEqual(['cells', 'truncated']);
      expect(Object.keys(clusterBody.cells[0]).sort()).toEqual([
        'cellId',
        'lat',
        'lng',
        'offers',
        'pickupPointId',
        'pickupPoints',
      ]);
      for (const res of [s, b, c])
        expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('US1 - rate limit', () => {
    it('S19 AS-08: the 121st request in a minute from one address answers 429 rate_limited with Retry-After', async () => {
      for (let i = 0; i < 120; i++) await search().expect(200);

      const res = await search().expect(429);

      expect(res.body.code).toBe('rate_limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('S19 AS-08: with the limiter store down the requests are allowed and the outage is counted', async () => {
      const labels = { policy: 'fulfilment.near-search', fail_mode: 'open' };
      const before =
        MetricsRegistry.value('rate_limit_store_unavailable_total', labels) ??
        0;
      t.redisProxy!.mode = 'refuse';
      try {
        for (let i = 0; i < 3; i++) await search().expect(200);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      const after =
        MetricsRegistry.value('rate_limit_store_unavailable_total', labels) ??
        0;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('US1 - the search index is unavailable or slow', () => {
    it.each([
      [
        'unreachable',
        (p: NonNullable<PickupTestApp['searchProxy']>) => {
          p.mode = 'refuse';
        },
      ],
      [
        'slower than 800 ms',
        (p: NonNullable<PickupTestApp['searchProxy']>) => {
          p.delayMs = 1000;
        },
      ],
    ])(
      'S19 AS-09: an index that is %s answers 503 search_unavailable with Retry-After and a generic detail, counts it, and the exact store is not queried',
      async (_name, fault) => {
        const proxy = t.searchProxy!;
        fault(proxy);
        let res;
        let statements: string[];
        try {
          ({ result: res, statements } = await recordStatements(
            t.app,
            () => search({ q: 'airpods' }),
            /PickupPoint|PickupStock/,
          ));
        } finally {
          proxy.mode = 'pass';
          proxy.delayMs = 0;
        }

        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          code: 'search_unavailable',
          status: 503,
        });
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(JSON.stringify(res.body)).not.toMatch(
          /elastic|9300|ECONN|timeout|127\.0\.0\.1/i,
        );
        expect(statements).toEqual([]);
        expect(
          MetricsRegistry.histogramValue('pickup_search_duration_seconds', {
            endpoint: 'search',
            outcome: 'unavailable',
          })?.count,
        ).toBeGreaterThanOrEqual(1);
      },
    );
  });

  describe('US6 - exact browse', () => {
    it('S19 AS-40: points at 0.5, 3, 4.95, 5.05 and 12 km: the first three in that order with the spheroid distance, the others excluded; equal distances break on id; inactive points and points of suspended shops are excluded', async () => {
      const distances = [3000, 500, 12_000, 4950, 5050];
      const made: { d: number; p: { id: string; name?: unknown } }[] = [];
      for (const d of distances)
        made.push({
          d,
          p: await t.createPoint(w.u1, w.s1.id, {
            ...(await eastOf(d)),
            name: `d${d}`,
          }),
        });
      const twin = await t.createPoint(w.u1, w.s1.id, {
        ...(await eastOf(3000)),
        name: 'twin',
      });
      const inactive = await t.createPoint(w.u1, w.s1.id, {
        ...(await eastOf(1000)),
        name: 'off',
      });
      await t
        .as(w.u1)
        .patch(`/api/shops/${w.s1.id}/pickup-points/${inactive.id}`)
        .send({ active: false })
        .expect(200);
      const foreign = await t.createPoint(w.u2, w.s2.id, {
        ...(await eastOf(2000)),
        name: 'suspended',
      });
      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s2.id, 'SUSPENDED', 2),
      ]);
      // the fixture points KREUZBERG (3.1 km) and MITTE (0.5 km) are in range too: look at the seeded ones only
      const seeded = new Set([...made.map((m) => m.p.id), twin.id]);

      const body = pickupPointsNearResponseSchema.parse(
        (await browse({ radiusKm: '5' }).expect(200)).body,
      );
      const got = body.items.filter((i) => seeded.has(i.id));

      const byName = (n: string) => got.find((i) => i.name === n);
      const tied = [made.find((m) => m.d === 3000)!.p, twin]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((p) => p.name as string);
      expect(got.map((i) => i.name)).toEqual(['d500', ...tied, 'd4950']);
      for (const d of [500, 3000, 4950])
        expect(Math.abs(byName(`d${d}`)!.distanceM - d)).toBeLessThanOrEqual(1);
      expect(body.items.map((i) => i.id)).not.toContain(inactive.id);
      expect(body.items.map((i) => i.id)).not.toContain(foreign.id);
      expect(body.items.map((i) => i.id)).not.toContain(
        made.find((m) => m.d === 5050)!.p.id,
      );
      // ordered by distance overall, the fixture points included
      const distancesGot = body.items.map((i) => i.distanceM);
      expect(distancesGot).toEqual([...distancesGot].sort((a, b) => a - b));
    });

    it('S19 AS-41: with productId only the points that hold it return, each with its quantity; without it there is no quantity; a productId that is not a UUID answers 400', async () => {
      const a = await t.product(w.s1.id);
      const third = await t.createPoint(w.u1, w.s1.id, {
        ...(await eastOf(2000)),
        name: 'third',
      });
      await stock(kreuzberg.id, a.id, 4);
      await stock(mitte.id, a.id, 2);
      await stock(third.id, a.id, 0);

      const withProduct = pickupPointsNearResponseSchema.parse(
        (await browse({ radiusKm: '10', productId: a.id }).expect(200)).body,
      );
      expect(withProduct.items.map((i) => [i.id, i.quantity]).sort()).toEqual(
        [
          [kreuzberg.id, 4],
          [mitte.id, 2],
        ].sort(),
      );
      const without = (await browse({ radiusKm: '10' }).expect(200)).body;
      expect(without.items).toHaveLength(3);
      for (const item of without.items)
        expect(item).not.toHaveProperty('quantity');
      const bad = await browse({ productId: 'abc' }).expect(400);
      expect(bad.body.errors.map((e: { field: string }) => e.field)).toContain(
        'productId',
      );
    });

    it('S19 AS-42: 60 points within 5 km come in pages of 50 and 10 without a gap or a repeat; the validation classes of AS-04 apply; the policy is the same', async () => {
      await t.sql(
        `INSERT INTO "PickupPoint" ("shopId", "name", "address", "location")
         SELECT :s, 'n' || g, 'a', ST_Project(ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, 100 + g * 50, radians(90))
           FROM generate_series(1, 58) g`,
        { s: w.s1.id, lat: ALEX.lat, lng: ALEX.lng },
      );
      const first = (await browse({ radiusKm: '5', limit: '50' }).expect(200))
        .body;
      const second = (
        await browse({
          radiusKm: '5',
          limit: '50',
          cursor: first.nextCursor,
        }).expect(200)
      ).body;

      expect([first.items.length, second.items.length]).toEqual([50, 10]);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items].map(
        (i: { id: string }) => i.id,
      );
      expect(new Set(ids).size).toBe(60);
      const all = [...first.items, ...second.items].map(
        (i: { distanceM: number }) => i.distanceM,
      );
      expect(all).toEqual([...all].sort((x, y) => x - y));
      for (const bad of [
        { lat: 'x' },
        { lng: '200' },
        { radiusKm: '0.01' },
        { limit: '0' },
        { limit: '51' },
        { cursor: 'zzz' },
        { q: 'x' },
      ])
        expect((await browse(bad).expect(400)).body.code).toBe(
          'validation_failed',
        );
    });

    it('S19 AS-42: the browse is under the same policy: the 121st request answers 429 rate_limited', async () => {
      for (let i = 0; i < 120; i++) await browse().expect(200);
      const res = await browse().expect(429);
      expect(res.body.code).toBe('rate_limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('S19 AS-43: a statement that runs past its limit is cancelled in the store and answers 503 service_unavailable with a generic detail', async () => {
      // another session holds the table while the browse asks for it, so its statement waits until the limit cancels it
      const observed = await t.app.get(TransactionRunner).run(async (tx) => {
        await t.app
          .get(Sequelize)
          .query(`LOCK TABLE "PickupPoint" IN ACCESS EXCLUSIVE MODE`, {
            transaction: tx,
          });
        const started = performance.now();
        const res = await browse({ radiusKm: '5' });
        return { res, took: performance.now() - started };
      });

      expect(observed.res.status).toBe(503);
      expect(observed.res.body.code).toBe('service_unavailable');
      expect(JSON.stringify(observed.res.body)).not.toMatch(
        /statement|timeout|PickupPoint|postgres/i,
      );
      expect(observed.took).toBeLessThan(5000);
      const running = await t.sql(
        `SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query ILIKE '%ST_DWithin%' AND pid <> pg_backend_pid()`,
      );
      expect(running).toEqual([]);
    });
  });
});
